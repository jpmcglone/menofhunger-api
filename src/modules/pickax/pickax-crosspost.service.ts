import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { PickaxApiClient, PickaxApiError } from './pickax-api.client';
import { PickaxConnectionService } from './pickax-connection.service';
import {
  articleCrosspostBlocker,
  buildPickaxArticlePayload,
  buildPickaxPostPayload,
  contentHash,
  pickaxArticleUrl,
  pickaxPostUrl,
  postCrosspostBlocker,
  type PickaxArticleSource,
  type PickaxPostSource,
} from './pickax-content';

export type PickaxQueueResult =
  | { status: 'queued' }
  | { status: 'skipped'; reason: string };

const POST_UPDATE_DELAY_MS = 5_000;
// Autosave can fire repeatedly; the job re-reads current content, so one delayed run covers a burst.
const ARTICLE_UPDATE_DELAY_MS = 20_000;

@Injectable()
export class PickaxCrosspostService {
  private readonly logger = new Logger(PickaxCrosspostService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly connections: PickaxConnectionService,
    private readonly api: PickaxApiClient,
    private readonly sideEffects: SideEffectsService,
  ) {}

  // ─── Request path ──────────────────────────────────────────────────────────

  async requestPostCrosspost(userId: string, postId: string): Promise<PickaxQueueResult> {
    if (!(await this.connections.getActiveConnection(userId))) return { status: 'skipped', reason: 'not_connected' };
    const post = await this.loadPost(postId);
    if (!post || post.userId !== userId) return { status: 'skipped', reason: 'not_found' };
    const blocker = postCrosspostBlocker(post.source);
    if (blocker) return { status: 'skipped', reason: blocker };
    this.sideEffects.dispatch('pickax.post.sync', { postId, create: true }, { jobId: `pickax-post-${postId}-create` });
    return { status: 'queued' };
  }

  async requestPostUpdate(userId: string, postId: string): Promise<void> {
    const existing = await this.prisma.pickaxCrosspost.findUnique({
      where: { kind_localId: { kind: 'post', localId: postId } },
      select: { userId: true, remoteId: true },
    });
    if (!existing?.remoteId || existing.userId !== userId) return;
    this.sideEffects.dispatch('pickax.post.sync', { postId, create: false }, {
      jobId: `pickax-post-${postId}-update`,
      delay: POST_UPDATE_DELAY_MS,
    });
  }

  async requestArticleCrosspost(userId: string, articleId: string): Promise<PickaxQueueResult> {
    if (!(await this.connections.getActiveConnection(userId))) return { status: 'skipped', reason: 'not_connected' };
    const article = await this.loadArticle(articleId);
    if (!article || article.authorId !== userId) return { status: 'skipped', reason: 'not_found' };
    const blocker = articleCrosspostBlocker(article.source);
    if (blocker) return { status: 'skipped', reason: blocker };
    const already = await this.prisma.pickaxCrosspost.findUnique({
      where: { kind_localId: { kind: 'article', localId: articleId } },
      select: { remoteId: true },
    });
    if (already?.remoteId) {
      await this.requestArticleUpdate(userId, articleId);
      return { status: 'queued' };
    }
    this.sideEffects.dispatch('pickax.article.sync', { articleId, create: true }, { jobId: `pickax-article-${articleId}-create` });
    return { status: 'queued' };
  }

  async requestArticleUpdate(userId: string, articleId: string): Promise<void> {
    const existing = await this.prisma.pickaxCrosspost.findUnique({
      where: { kind_localId: { kind: 'article', localId: articleId } },
      select: { userId: true, remoteId: true },
    });
    if (!existing?.remoteId || existing.userId !== userId) return;
    this.sideEffects.dispatch('pickax.article.sync', { articleId, create: false }, {
      jobId: `pickax-article-${articleId}-update`,
      delay: ARTICLE_UPDATE_DELAY_MS,
    });
  }

  // ─── Worker path ───────────────────────────────────────────────────────────

  async syncPost(postId: string, create: boolean): Promise<void> {
    const loaded = await this.loadPost(postId);
    if (!loaded) return;
    const userId = loaded.userId;
    const conn = await this.connections.getActiveConnection(userId);
    if (!conn) return;

    const row = await this.prisma.pickaxCrosspost.findUnique({
      where: { kind_localId: { kind: 'post', localId: postId } },
    });
    // Forward-only: an update never creates, and a create never runs twice.
    if (create ? Boolean(row?.remoteId) : !row?.remoteId) return;
    if (postCrosspostBlocker(loaded.source)) return;

    const payload = buildPickaxPostPayload(loaded.source, {
      publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
      mohPostUrl: `${this.siteBaseUrl()}/p/${encodeURIComponent(postId)}`,
    });
    const hash = contentHash(payload.content);
    if (!create && row?.contentHash === hash) return;

    await this.runWithToken(userId, async (token) => {
      if (create) {
        const remoteId = await this.api.createPost(token, `moh-post-${postId}-create`, payload);
        await this.saveRow(userId, 'post', postId, remoteId, hash);
      } else {
        await this.api.updatePost(token, `moh-post-${postId}-u-${hash.slice(0, 16)}`, row!.remoteId!, {
          content: payload.content,
        });
        await this.saveRow(userId, 'post', postId, row!.remoteId, hash);
      }
    }, { kind: 'post', localId: postId });
  }

  async syncArticle(articleId: string, create: boolean): Promise<void> {
    const loaded = await this.loadArticle(articleId);
    if (!loaded) return;
    const userId = loaded.authorId;
    const conn = await this.connections.getActiveConnection(userId);
    if (!conn) return;

    const row = await this.prisma.pickaxCrosspost.findUnique({
      where: { kind_localId: { kind: 'article', localId: articleId } },
    });
    if (create ? Boolean(row?.remoteId) : !row?.remoteId) return;
    if (articleCrosspostBlocker(loaded.source)) return;

    const payload = buildPickaxArticlePayload(loaded.source, {
      publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
      author: loaded.author,
      siteBaseUrl: this.siteBaseUrl(),
    });
    const hash = contentHash(payload.title, payload.content, payload.thumbnail ?? null);
    if (!create && row?.contentHash === hash) return;

    await this.runWithToken(userId, async (token) => {
      if (create) {
        const remoteId = await this.api.createArticle(token, `moh-article-${articleId}-create`, payload);
        await this.saveRow(userId, 'article', articleId, remoteId, hash);
      } else {
        await this.api.updateArticle(token, `moh-article-${articleId}-u-${hash.slice(0, 16)}`, row!.remoteId!, {
          title: payload.title,
          content: payload.content,
          thumbnail: payload.thumbnail ?? null,
        });
        await this.saveRow(userId, 'article', articleId, row!.remoteId, hash);
      }
    }, { kind: 'article', localId: articleId });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Runs a Pickax call with a fresh token. A rejected token is renewed once; credentials Pickax
   * no longer accepts flag the connection; transient failures rethrow so the queue retries
   * (idempotency keys make the retry safe).
   */
  private async runWithToken(
    userId: string,
    fn: (token: string) => Promise<void>,
    target: { kind: 'post' | 'article'; localId: string },
  ): Promise<void> {
    const conn = await this.connections.getActiveConnection(userId);
    if (!conn) return;
    try {
      try {
        await fn(await this.connections.accessTokenFor(conn));
      } catch (err) {
        if (!(err instanceof PickaxApiError) || !err.isAuthFailure) throw err;
        await this.connections.invalidateAccessToken(userId);
        const fresh = await this.connections.getActiveConnection(userId);
        if (!fresh) return;
        await fn(await this.connections.accessTokenFor(fresh));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof PickaxApiError && err.isRetryable) {
        this.logger.warn(`Pickax ${target.kind} ${target.localId} will retry: ${message}`);
        throw err;
      }
      const authFailure = err instanceof PickaxApiError && err.isAuthFailure;
      this.logger.warn(`Pickax ${target.kind} ${target.localId} failed: ${message}`);
      await this.connections.markError(
        userId,
        authFailure ? 'Pickax no longer accepts this API key. Reconnect with a new key.' : message,
        authFailure,
      );
      await this.prisma.pickaxCrosspost.updateMany({
        where: { kind: target.kind, localId: target.localId },
        data: { lastError: message.slice(0, 500) },
      });
      await this.recordRowError(target, message.slice(0, 500));
    }
  }

  private async saveRow(
    userId: string,
    kind: 'post' | 'article',
    localId: string,
    remoteId: string | null,
    hash: string,
  ): Promise<void> {
    await this.prisma.pickaxCrosspost.upsert({
      where: { kind_localId: { kind, localId } },
      create: { userId, kind, localId, remoteId, contentHash: hash },
      update: { remoteId, contentHash: hash, lastError: null },
    });
    // Denormalize the public link so readers can jump to the Pickax copy, and clear any
    // earlier rejection now that Pickax has accepted the content.
    if (remoteId) {
      const pickaxUrl = kind === 'post' ? pickaxPostUrl(remoteId) : pickaxArticleUrl(remoteId);
      if (kind === 'post') {
        await this.prisma.post.updateMany({ where: { id: localId }, data: { pickaxUrl, pickaxError: null } });
      } else {
        await this.prisma.article.updateMany({ where: { id: localId }, data: { pickaxUrl, pickaxError: null } });
      }
    }
    await this.connections.clearError(userId);
  }

  /** Author-facing failure note on the post/article itself, so the error is visible where they published. */
  private async recordRowError(
    target: { kind: 'post' | 'article'; localId: string },
    message: string,
  ): Promise<void> {
    if (target.kind === 'post') {
      await this.prisma.post.updateMany({ where: { id: target.localId }, data: { pickaxError: message } });
    } else {
      await this.prisma.article.updateMany({ where: { id: target.localId }, data: { pickaxError: message } });
    }
  }

  private siteBaseUrl(): string {
    return (this.appConfig.frontendBaseUrl() ?? 'https://menofhunger.com').replace(/\/+$/, '');
  }

  private async loadPost(postId: string): Promise<{ userId: string; source: PickaxPostSource } | null> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: {
        id: true,
        userId: true,
        body: true,
        visibility: true,
        kind: true,
        boardOnly: true,
        isDraft: true,
        deletedAt: true,
        scheduledAt: true,
        parentId: true,
        communityGroupId: true,
        quotedPostId: true,
        repostedPostId: true,
        poll: { select: { id: true } },
        media: { select: { kind: true, source: true, r2Key: true, alt: true, deletedAt: true, position: true } },
      },
    });
    if (!post) return null;
    const { poll, userId, ...rest } = post;
    return { userId, source: { ...rest, hasPoll: Boolean(poll) } };
  }

  private async loadArticle(
    articleId: string,
  ): Promise<{ authorId: string; author: { name: string | null; username: string }; source: PickaxArticleSource } | null> {
    const article = await this.prisma.article.findUnique({
      where: { id: articleId },
      select: {
        id: true,
        authorId: true,
        title: true,
        body: true,
        visibility: true,
        isDraft: true,
        publishedAt: true,
        deletedAt: true,
        thumbnailR2Key: true,
        author: { select: { name: true, username: true } },
      },
    });
    const username = article?.author.username;
    if (!article || !username) return null;
    const { author, authorId, ...source } = article;
    return { authorId, author: { name: author.name, username }, source };
  }
}
