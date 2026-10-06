import { OutboundService } from '../outbound/outbound.service';
import { Injectable, Logger } from '@nestjs/common';
import type { CrosspostMode } from '@prisma/client';
import { linkBlocker, resolveCrosspostMode } from '../../common/crosspost/crosspost-eligibility';
import { AppConfigService } from '../app/app-config.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PrismaService } from '../prisma/prisma.service';
import { PickaxApiClient, PickaxApiError } from './pickax-api.client';
import { PickaxConnectionService } from './pickax-connection.service';
import {
  PICKAX_NATIVE_LIMITS,
  articleCrosspostBlocker,
  buildPickaxArticlePayload,
  buildPickaxLinkPayload,
  buildPickaxPostPayload,
  contentHash,
  pickaxArticleUrl,
  pickaxPostUrl,
  postCrosspostBlocker,
  type PickaxArticleSource,
  type PickaxPostSource,
} from './pickax-content';

export type PickaxQueueResult =
  | { status: 'queued'; mode: CrosspostMode }
  | { status: 'skipped'; reason: string };

// Autosave can fire repeatedly; the job re-reads current content, so one delayed run covers a burst.

@Injectable()
export class PickaxCrosspostService {
  private readonly logger = new Logger(PickaxCrosspostService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: OutboundService,
    private readonly appConfig: AppConfigService,
    private readonly connections: PickaxConnectionService,
    private readonly api: PickaxApiClient,
    private readonly realtime: PresenceRealtimeService,
  ) {}

  // ─── Request path ──────────────────────────────────────────────────────────

  async requestPostCrosspost(
    userId: string,
    postId: string,
    requested: CrosspostMode = 'link',
  ): Promise<PickaxQueueResult> {
    const author = await this.prisma.user.findUnique({ where: { id: userId }, select: { verifiedStatus: true, bannedAt: true } });
    if (!author || author.bannedAt || author.verifiedStatus === 'none') return { status: 'skipped', reason: 'verification_required' };
    if (!(await this.connections.getActiveConnection(userId))) return { status: 'skipped', reason: 'not_connected' };
    const post = await this.loadPost(postId);
    if (!post || post.userId !== userId) return { status: 'skipped', reason: 'not_found' };
    const resolved = resolveCrosspostMode(post.source, requested, PICKAX_NATIVE_LIMITS);
    if ('skip' in resolved) return { status: 'skipped', reason: resolved.skip };
    const existing = await this.prisma.pickaxCrosspost.findUnique({
      where: { kind_localId: { kind: 'post', localId: postId } },
      select: { userId: true, remoteId: true, mode: true },
    });
    if (existing?.remoteId) {
      if (existing.userId !== userId) return { status: 'skipped', reason: 'not_found' };
      await this.requestPostUpdate(userId, postId);
      return { status: 'queued', mode: existing.mode };
    }
    await this.prisma.pickaxCrosspost.upsert({
      where: { kind_localId: { kind: 'post', localId: postId } },
      create: { userId, kind: 'post', localId: postId, mode: resolved.mode },
      update: { mode: resolved.mode, lastError: null },
    });
    await this.outbound.ensure(userId, 'pickax', 'post', postId, resolved.mode);
    return { status: 'queued', mode: resolved.mode };
  }

  async requestPostUpdate(userId: string, postId: string): Promise<void> {
    const existing = await this.prisma.pickaxCrosspost.findUnique({
      where: { kind_localId: { kind: 'post', localId: postId } },
      select: { userId: true, remoteId: true },
    });
    if (!existing?.remoteId || existing.userId !== userId) return;
    await this.outbound.ensure(userId, 'pickax', 'post', postId, 'native', true);
  }

  async requestArticleCrosspost(
    userId: string,
    articleId: string,
    requested: CrosspostMode = 'link',
  ): Promise<PickaxQueueResult> {
    const author = await this.prisma.user.findUnique({ where: { id: userId }, select: { verifiedStatus: true, bannedAt: true } });
    if (!author || author.bannedAt || author.verifiedStatus === 'none') return { status: 'skipped', reason: 'verification_required' };
    if (!(await this.connections.getActiveConnection(userId))) return { status: 'skipped', reason: 'not_connected' };
    const article = await this.loadArticle(articleId);
    if (!article || article.authorId !== userId) return { status: 'skipped', reason: 'not_found' };
    const blocker = articleCrosspostBlocker(article.source);
    if (blocker) return { status: 'skipped', reason: blocker };
    const already = await this.prisma.pickaxCrosspost.findUnique({
      where: { kind_localId: { kind: 'article', localId: articleId } },
      select: { userId: true, remoteId: true, mode: true },
    });
    if (already?.remoteId) {
      if (already.userId !== userId) return { status: 'skipped', reason: 'not_found' };
      await this.requestArticleUpdate(userId, articleId);
      return { status: 'queued', mode: already.mode };
    }
    await this.prisma.pickaxCrosspost.upsert({
      where: { kind_localId: { kind: 'article', localId: articleId } },
      create: { userId, kind: 'article', localId: articleId, mode: requested },
      update: { mode: requested, lastError: null },
    });
    await this.outbound.ensure(userId, 'pickax', 'article', articleId, requested);
    return { status: 'queued', mode: requested };
  }

  async requestArticleUpdate(userId: string, articleId: string): Promise<void> {
    const existing = await this.prisma.pickaxCrosspost.findUnique({
      where: { kind_localId: { kind: 'article', localId: articleId } },
      select: { userId: true, remoteId: true },
    });
    if (!existing?.remoteId || existing.userId !== userId) return;
    await this.outbound.ensure(userId, 'pickax', 'article', articleId, 'native', true);
  }

  // ─── Worker path ───────────────────────────────────────────────────────────

  async syncPost(postId: string, create: boolean, generation?: string): Promise<void> {
    const loaded = await this.loadPost(postId);
    if (!loaded) return;
    const userId = loaded.userId;
    const conn = await this.connections.getActiveConnection(userId);
    if (!conn) {
      await this.recordRowError({ kind: 'post', localId: postId }, userId, 'Pickax is not connected.');
      return;
    }

    const row = await this.prisma.pickaxCrosspost.findUnique({
      where: { kind_localId: { kind: 'post', localId: postId } },
    });
    const mode: CrosspostMode = row?.mode ?? 'native';
    // Forward-only: an update never creates, and a create never runs twice.
    if (create ? Boolean(row?.remoteId) : !row?.remoteId) return;
    if (mode === 'link' ? linkBlocker(loaded.source) : postCrosspostBlocker(loaded.source)) {
      await this.recordRowError({ kind: 'post', localId: postId }, userId, 'This post can no longer be shared to Pickax.');
      return;
    }

    const isBoard = loaded.source.kind === 'board';
    const mohPostUrl = `${this.siteBaseUrl()}/${isBoard ? 'b' : 'p'}/${encodeURIComponent(postId)}`;
    const payload = mode === 'link'
      ? buildPickaxLinkPayload(mohPostUrl, isBoard ? loaded.boardTitle ?? '' : loaded.source.body)
      : buildPickaxPostPayload(loaded.source, { publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null });
    if (payload.content.length > 1000) {
      await this.recordRowError({ kind: 'post', localId: postId }, userId, 'This post exceeds Pickax’s limit. Shorten it or share a link instead.');
      return;
    }
    const hash = contentHash(mode, JSON.stringify(payload));
    if (!create && row?.contentHash === hash) return;

    await this.runWithToken(userId, async (token) => {
      if (create) {
        const remoteId = await this.api.createPost(token, `moh-post-${postId}-create`, payload);
        await this.saveRow(userId, 'post', postId, mode, remoteId, hash);
      } else {
        await this.api.updatePost(token, `moh-post-${postId}-u-${hash.slice(0, 16)}`, row!.remoteId!, {
          ...payload, attachments: payload.attachments ?? [],
        });
        await this.saveRow(userId, 'post', postId, mode, row!.remoteId, hash);
      }
    }, { kind: 'post', localId: postId }, generation);
  }

  async syncArticle(articleId: string, create: boolean, generation?: string): Promise<void> {
    const loaded = await this.loadArticle(articleId);
    if (!loaded) return;
    const userId = loaded.authorId;
    const conn = await this.connections.getActiveConnection(userId);
    if (!conn) {
      await this.recordRowError({ kind: 'article', localId: articleId }, userId, 'Pickax is not connected.');
      return;
    }

    const row = await this.prisma.pickaxCrosspost.findUnique({
      where: { kind_localId: { kind: 'article', localId: articleId } },
    });
    const mode: CrosspostMode = row?.mode ?? 'native';
    if (create ? Boolean(row?.remoteId) : !row?.remoteId) return;
    if (articleCrosspostBlocker(loaded.source)) {
      await this.recordRowError({ kind: 'article', localId: articleId }, userId, 'This article can no longer be shared to Pickax.');
      return;
    }

    const siteBaseUrl = this.siteBaseUrl();
    const articleUrl = `${siteBaseUrl}/a/${encodeURIComponent(articleId)}`;
    const linkPayload = buildPickaxLinkPayload(articleUrl, loaded.source.title);
    const articlePayload = buildPickaxArticlePayload(loaded.source, {
      publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
    });
    const hash = mode === 'link'
      ? contentHash('link', linkPayload.content)
      : contentHash('native', articlePayload.title, articlePayload.content, articlePayload.thumbnail ?? null);
    if (!create && row?.contentHash === hash) return;

    await this.runWithToken(userId, async (token) => {
      if (mode === 'link') {
        if (create) {
          const remoteId = await this.api.createPost(token, `moh-article-${articleId}-link`, linkPayload);
          await this.saveRow(userId, 'article', articleId, mode, remoteId, hash);
        } else {
          await this.api.updatePost(token, `moh-article-${articleId}-u-${hash.slice(0, 16)}`, row!.remoteId!, {
            content: linkPayload.content,
          });
          await this.saveRow(userId, 'article', articleId, mode, row!.remoteId, hash);
        }
        return;
      }
      if (create) {
        const remoteId = await this.api.createArticle(token, `moh-article-${articleId}-create`, articlePayload);
        await this.saveRow(userId, 'article', articleId, mode, remoteId, hash);
      } else {
        await this.api.updateArticle(token, `moh-article-${articleId}-u-${hash.slice(0, 16)}`, row!.remoteId!, {
          title: articlePayload.title,
          content: articlePayload.content,
          thumbnail: articlePayload.thumbnail ?? null,
        });
        await this.saveRow(userId, 'article', articleId, mode, row!.remoteId, hash);
      }
    }, { kind: 'article', localId: articleId }, generation);
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
    generation?: string,
  ): Promise<void> {
    const conn = await this.connections.getActiveConnection(userId);
    if (!conn || (generation && conn.generation !== generation)) {
      await this.recordRowError(target, userId, 'Pickax is not connected.');
      return;
    }
    try {
      try {
        await fn(await this.connections.accessTokenFor(conn));
      } catch (err) {
        if (!(err instanceof PickaxApiError) || !err.isAuthFailure) throw err;
        await this.connections.invalidateAccessToken(userId, conn.generation);
        const fresh = await this.connections.getActiveConnection(userId);
        if (!fresh || fresh.generation !== conn.generation) {
          await this.recordRowError(target, userId, 'Pickax is not connected.');
          return;
        }
        await fn(await this.connections.accessTokenFor(fresh));
      }
      await this.connections.clearError(userId, conn.generation);
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
        conn.generation,
      );
      await this.prisma.pickaxCrosspost.updateMany({
        where: { kind: target.kind, localId: target.localId },
        data: { lastError: message.slice(0, 500) },
      });
      await this.recordRowError(target, userId, message.slice(0, 500));
    }
  }

  private async saveRow(
    userId: string,
    kind: 'post' | 'article',
    localId: string,
    mode: CrosspostMode,
    remoteId: string | null,
    hash: string,
  ): Promise<void> {
    await this.prisma.pickaxCrosspost.upsert({
      where: { kind_localId: { kind, localId } },
      create: { userId, kind, localId, mode, remoteId, contentHash: hash },
      update: { remoteId, contentHash: hash, lastError: null },
    });
    // Denormalize the public link so readers can jump to the Pickax copy, and clear any
    // earlier rejection now that Pickax has accepted the content.
    if (remoteId) {
      const pickaxUrl = mode === 'link' || kind === 'post' ? pickaxPostUrl(remoteId) : pickaxArticleUrl(remoteId);
      if (kind === 'post') {
        await this.prisma.post.updateMany({ where: { id: localId }, data: { pickaxUrl, pickaxError: null } });
      } else {
        await this.prisma.article.updateMany({ where: { id: localId }, data: { pickaxUrl, pickaxError: null } });
      }
      this.announce(kind, localId, userId, { pickaxUrl }, true);
    }
  }

  /** Author-facing failure note on the post/article itself, so the error is visible where they published. */
  private async recordRowError(
    target: { kind: 'post' | 'article'; localId: string },
    userId: string,
    message: string,
  ): Promise<void> {
    const note = message.slice(0, 500);
    if (target.kind === 'post') {
      await this.prisma.post.updateMany({ where: { id: target.localId }, data: { pickaxError: note } });
    } else {
      await this.prisma.article.updateMany({ where: { id: target.localId }, data: { pickaxError: note } });
    }
    this.announce(target.kind, target.localId, userId, { pickaxError: note }, false);
  }

  /** Public link goes to the post/article room and the author. Failures stay on the author's socket. */
  private announce(
    kind: 'post' | 'article',
    localId: string,
    userId: string,
    patch: { pickaxUrl?: string; pickaxError?: string },
    isPublic: boolean,
  ): void {
    const version = new Date().toISOString();
    if (kind === 'post') {
      const payload = { postId: localId, version, reason: 'crosspost', patch };
      if (isPublic) this.realtime.emitPostsLiveUpdated(localId, payload);
      this.realtime.emitPostsLiveUpdatedToUser(userId, payload);
      return;
    }
    const payload = { articleId: localId, version, reason: 'crosspost', patch };
    if (isPublic) this.realtime.emitArticlesLiveUpdated(localId, payload);
    this.realtime.emitArticlesLiveUpdatedToUser(userId, payload);
  }

  private siteBaseUrl(): string {
    return (this.appConfig.frontendBaseUrl() ?? 'https://menofhunger.com').replace(/\/+$/, '');
  }

  private async loadPost(postId: string): Promise<{ userId: string; boardTitle: string | null; source: PickaxPostSource } | null> {
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
        boardThread: { select: { title: true } },
        media: { select: { kind: true, source: true, r2Key: true, alt: true, deletedAt: true, position: true } },
      },
    });
    if (!post) return null;
    const { poll, userId, boardThread, ...rest } = post;
    return { userId, boardTitle: boardThread?.title ?? null, source: { ...rest, hasPoll: Boolean(poll) } };
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
