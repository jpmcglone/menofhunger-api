import { OutboundService } from '../outbound/outbound.service';
import { XUsageService } from './x-usage.service';
import { Injectable, Logger } from '@nestjs/common';
import type { CrosspostMode, PickaxCrosspostKind } from '@prisma/client';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import {
  X_NATIVE_COST_MICROS,
  X_POST_MAX_IMAGES,
  xPostBlocker,
  xBlockerMessage,
  xContainsLink,
  xPostCostMicros,
} from '../../common/crosspost/crosspost-eligibility';
import { AppConfigService } from '../app/app-config.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PrismaService } from '../prisma/prisma.service';
import { XApiClient, XApiError } from './x-api.client';
import { XConnectionService, monthStartUtc } from './x-connection.service';

export type XQueueResult =
  | { status: 'queued'; mode: CrosspostMode }
  | { status: 'skipped'; reason: string };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type LoadedPost = {
  userId: string;
  body: string;
  visibility: string;
  kind: string;
  boardOnly: boolean;
  isDraft: boolean;
  deletedAt: Date | null;
  scheduledAt: Date | null;
  parentId: string | null;
  communityGroupId: string | null;
  quotedPostId: string | null;
  repostedPostId: string | null;
  hasPoll: boolean;
  media: Array<{
    kind: string;
    source: string;
    r2Key: string | null;
    alt: string | null;
    deletedAt: Date | null;
    position: number;
  }>;
};

@Injectable()
export class XCrosspostService {
  private readonly logger = new Logger(XCrosspostService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: OutboundService,
    private readonly usage: XUsageService,
    private readonly appConfig: AppConfigService,
    private readonly connections: XConnectionService,
    private readonly api: XApiClient,
    private readonly realtime: PresenceRealtimeService,
  ) {}

  async requestPostCrosspost(userId: string, postId: string, requested: CrosspostMode): Promise<XQueueResult> {
    const post = await this.loadPost(postId);
    if (!post || post.userId !== userId) return { status: 'skipped', reason: 'not_found' };
    const reason = xPostBlocker(post, requested);
    if (reason) return { status: 'skipped', reason };
    const text = post.body.trim();
    return this.reserveAndQueue({
      userId,
      kind: 'post',
      localId: postId,
      mode: 'native',
      costMicros: xPostCostMicros(text),
      job: 'x.post.sync',
    });
  }

  async requestArticleCrosspost(userId: string, articleId: string): Promise<XQueueResult> {
    const article = await this.prisma.article.findUnique({
      where: { id: articleId },
      select: { authorId: true, title: true, visibility: true, isDraft: true, publishedAt: true, deletedAt: true },
    });
    if (!article || article.authorId !== userId) return { status: 'skipped', reason: 'not_found' };
    if (article.deletedAt || article.isDraft || !article.publishedAt) return { status: 'skipped', reason: 'not_published' };
    if (article.visibility !== 'public') return { status: 'skipped', reason: 'not_public' };
    return { status: 'skipped', reason: 'link_sharing_unsupported' };
  }

  async syncPost(postId: string, generation?: string): Promise<void> {
    const post = await this.loadPost(postId);
    if (!post) return;
    const row = await this.prisma.xCrosspost.findUnique({ where: { kind_localId: { kind: 'post', localId: postId } } });
    if (!row || row.remoteId || row.refundedAt || row.userId !== post.userId) return;
    const reason = xPostBlocker(post, row.mode);
    if (reason) {
      await this.fail('post', postId, post.userId, xBlockerMessage(reason));
      return;
    }
    await this.publish(post.userId, 'post', postId, post.body.trim(), post.media, generation);
  }

  async syncArticle(articleId: string, _generation?: string): Promise<void> {
    const article = await this.prisma.article.findUnique({
      where: { id: articleId },
      select: { authorId: true, title: true, visibility: true, isDraft: true, publishedAt: true, deletedAt: true },
    });
    const row = await this.prisma.xCrosspost.findUnique({ where: { kind_localId: { kind: 'article', localId: articleId } } });
    if (!article || !row || row.remoteId || row.refundedAt || row.userId !== article.authorId) return;
    await this.fail('article', articleId, article.authorId, 'Articles cannot be posted to X because they require a link.');
  }

  private async reserveAndQueue(input: {
    userId: string;
    kind: PickaxCrosspostKind;
    localId: string;
    mode: CrosspostMode;
    costMicros: number;
    job: 'x.post.sync' | 'x.article.sync';
  }): Promise<XQueueResult> {
    if (!(await this.connections.getActiveConnection(input.userId))) return { status: 'skipped', reason: 'not_connected' };
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { premium: true, premiumPlus: true, verifiedStatus: true, bannedAt: true },
    });
    if (!user || user.bannedAt || user.verifiedStatus === 'none') return { status: 'skipped', reason: 'verification_required' };
    if (!this.appConfig.partner().xCountAllowance && !user.premium && !user.premiumPlus) return { status: 'skipped', reason: 'premium_required' };
    const config = this.appConfig.x();
    if (!config) return { status: 'skipped', reason: 'not_available' };

    const existing = await this.prisma.xCrosspost.findUnique({
      where: { kind_localId: { kind: input.kind, localId: input.localId } },
    });
    if (existing?.remoteId) return { status: 'queued', mode: existing.mode };
    if (existing && !existing.refundedAt) {
      this.dispatch(input);
      return { status: 'queued', mode: existing.mode };
    }

    const budgetMicros = config.monthlyBudgetCents * 10_000;
    const reserved = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`x:${input.userId}`}))`;
      const current = await tx.xCrosspost.findUnique({
        where: { kind_localId: { kind: input.kind, localId: input.localId } },
      });
      if (current?.remoteId || (current && !current.refundedAt)) return 'already' as const;
      const spent = await tx.xCrosspost.aggregate({
        where: { userId: input.userId, refundedAt: null, createdAt: { gte: monthStartUtc() } },
        _sum: { costMicros: true },
      });
      if (!this.appConfig.partner().xCountAllowance && (spent._sum.costMicros ?? 0) + input.costMicros > budgetMicros) return 'monthly_limit' as const;
      if (current) {
        await tx.xCrosspost.update({
          where: { id: current.id },
          data: { mode: input.mode, costMicros: input.costMicros, refundedAt: null, lastError: null },
        });
      } else {
        await tx.xCrosspost.create({
          data: {
            userId: input.userId,
            kind: input.kind,
            localId: input.localId,
            mode: input.mode,
            costMicros: input.costMicros,
          },
        });
      }
      return 'ok' as const;
    });
    if (reserved === 'monthly_limit') return { status: 'skipped', reason: 'monthly_limit' };
    this.dispatch(input);
    return { status: 'queued', mode: input.mode };
  }

  private dispatch(input: { userId: string; mode: CrosspostMode; kind: PickaxCrosspostKind; localId: string; job: 'x.post.sync' | 'x.article.sync' }): void {
    void this.outbound.ensure(input.userId, 'x', input.kind, input.localId, input.mode);
  }

  private async reserveLegacyDeliveryCost(userId: string, kind: PickaxCrosspostKind, localId: string, costMicros: number): Promise<boolean> {
    const config = this.appConfig.x();
    if (!config) return false;
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`x:${userId}`}))`;
      const user = await tx.user.findUnique({ where: { id: userId }, select: { premium: true, premiumPlus: true, verifiedStatus: true, bannedAt: true } });
      if (!user || user.bannedAt || user.verifiedStatus === 'none' || (!user.premium && !user.premiumPlus)) return false;
      const spent = await tx.xCrosspost.aggregate({ where: { userId, refundedAt: null, createdAt: { gte: monthStartUtc() }, NOT: { kind, localId } }, _sum: { costMicros: true } });
      if ((spent._sum.costMicros ?? 0) + costMicros > config.monthlyBudgetCents * 10_000) return false;
      // Recovery may create the mapping before the request-path reservation runs.
      // Charge the final payload under the same account lock before any network send.
      const updated = await tx.xCrosspost.updateMany({ where: { userId, kind, localId, remoteId: null }, data: { costMicros, refundedAt: null } });
      return updated.count > 0;
    });
  }

  private async publish(
    userId: string,
    kind: PickaxCrosspostKind,
    localId: string,
    text: string,
    media: LoadedPost['media'],
    generation?: string,
  ): Promise<void> {
    if (xContainsLink(text)) {
      await this.fail(kind, localId, userId, xBlockerMessage('links_unsupported'));
      return;
    }
    const conn = await this.connections.getActiveConnection(userId);
    if (!conn || (generation && conn.generation !== generation)) {
      await this.fail(kind, localId, userId, 'X is not connected.');
      return;
    }
    const reservationId = `x:${kind}:${localId}`;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { verifiedStatus: true, bannedAt: true } });
    if (!user || user.bannedAt || user.verifiedStatus === 'none') {
      await this.fail(kind, localId, userId, 'Verify your account before sharing to X.');
      return;
    }
    const costMicros = xPostCostMicros(text);
    if (this.appConfig.partner().xCountAllowance) {
      if (!(await this.usage.reserve(reservationId, userId, conn.xUserId, costMicros > X_NATIVE_COST_MICROS))) {
        await this.fail(kind, localId, userId, 'Your monthly X allowance for this kind of post is used up.');
        return;
      }
      await this.prisma.xCrosspost.updateMany({ where: { kind, localId }, data: { costMicros } });
    } else if (!(await this.reserveLegacyDeliveryCost(userId, kind, localId, costMicros))) {
      await this.fail(kind, localId, userId, 'X sharing is unavailable under this account’s current allowance.');
      return;
    }
    try {
      const token = await this.freshToken(userId, conn.generation);
      const mediaIds = await this.uploadImages(token, media);
      const remoteId = await this.api.createPost(token, { text: text || ' ', mediaIds });
      const username = (await this.prisma.xConnection.findUnique({ where: { userId }, select: { username: true } }))?.username
        ?? conn.username;
      await this.prisma.xCrosspost.updateMany({
        where: { kind, localId },
        data: { remoteId, lastError: null },
      });
      const xUrl = `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(remoteId)}`;
      if (kind === 'post') {
        await this.prisma.post.updateMany({ where: { id: localId }, data: { xUrl, xError: null } });
      } else {
        await this.prisma.article.updateMany({ where: { id: localId }, data: { xUrl, xError: null } });
      }
      await this.usage.settle(reservationId, 'sent');
      this.announce(kind, localId, userId, { xUrl }, true);
      await this.connections.clearError(userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof XApiError && err.isRetryable) {
        this.logger.warn(`X ${kind} ${localId} will retry: ${message}`);
        throw err;
      }
      if (err instanceof XApiError && err.duplicateRisk) {
        await this.usage.settle(reservationId, 'uncertain');
        const uncertain = 'Delivery is uncertain. Check X before retrying.';
        await this.prisma.xCrosspost.updateMany({ where: { kind, localId }, data: { lastError: uncertain } });
        if (kind === 'post') await this.prisma.post.updateMany({ where: { id: localId }, data: { xError: uncertain } });
        else await this.prisma.article.updateMany({ where: { id: localId }, data: { xError: uncertain } });
        this.announce(kind, localId, userId, { xError: uncertain }, false);
        return;
      }
      await this.usage.settle(reservationId, 'released');
      const authFailure = err instanceof XApiError && err.isAuthFailure;
      if (authFailure) {
        await this.connections.markError(userId, 'X needs to be connected again.', true);
      }
      await this.fail(kind, localId, userId, message.slice(0, 500));
    }
  }

  private async freshToken(userId: string, generation?: string): Promise<string> {
    const conn = await this.connections.getActiveConnection(userId);
    if (!conn || (generation && conn.generation !== generation)) throw new XApiError(401, 'not_connected', 'X is not connected.');
    try {
      return await this.connections.accessTokenFor(conn);
    } catch (err) {
      if (!(err instanceof XApiError) || !err.isAuthFailure) throw err;
      await this.connections.invalidateAccessToken(userId);
      const fresh = await this.connections.getActiveConnection(userId);
      if (!fresh || fresh.generation !== conn.generation) throw err;
      return this.connections.accessTokenFor(fresh);
    }
  }

  private async uploadImages(token: string, media: LoadedPost['media']): Promise<string[]> {
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const images = media
      .filter((item) => !item.deletedAt && item.kind === 'image' && item.source === 'upload' && item.r2Key)
      .sort((a, b) => a.position - b.position)
      .slice(0, X_POST_MAX_IMAGES);
    const ids: string[] = [];
    for (const image of images) {
      const url = publicAssetUrl({ publicBaseUrl, key: image.r2Key });
      if (!url) continue;
      const file = await this.fetchImage(url);
      ids.push(await this.api.uploadImage(token, { ...file, alt: image.alt }));
    }
    return ids;
  }

  private async fetchImage(url: string): Promise<{ bytes: Buffer; contentType: string }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new XApiError(400, 'image_fetch', 'Could not fetch an image.');
    }
    let allowedOrigin: string | null = null;
    try {
      const allowed = this.appConfig.r2()?.publicBaseUrl;
      allowedOrigin = allowed ? new URL(allowed).origin : null;
    } catch {
      allowedOrigin = null;
    }
    if (parsed.protocol !== 'https:' || !allowedOrigin || parsed.origin !== allowedOrigin) {
      throw new XApiError(400, 'image_fetch', 'Could not fetch an image.');
    }
    let res: Response;
    try {
      res = await fetch(parsed.toString(), { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new XApiError(0, 'network_error', err instanceof Error ? err.message : 'Could not fetch the image.');
    }
    if (!res.ok) throw new XApiError(res.status, 'image_fetch', `Could not fetch an image (${res.status}).`);
    const contentType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
      throw new XApiError(400, 'image_fetch', 'X can only take JPEG, PNG, or WebP photos.');
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw new XApiError(400, 'image_too_large', 'An image is too large to post on X.');
    return { bytes, contentType };
  }

  private async fail(kind: PickaxCrosspostKind, localId: string, userId: string, message: string): Promise<void> {
    this.logger.warn(`X ${kind} ${localId} failed: ${message}`);
    const note = message.slice(0, 500);
    await this.prisma.xCrosspost.updateMany({
      where: { kind, localId, remoteId: null },
      data: { lastError: note, refundedAt: new Date() },
    });
    await this.usage.settle(`x:${kind}:${localId}`, 'released');
    await this.writeError(kind, localId, note);
    this.announce(kind, localId, userId, { xError: note }, false);
  }

  /** Public link goes to the post/article room and the author. Failures stay on the author's socket. */
  private announce(
    kind: PickaxCrosspostKind,
    localId: string,
    userId: string,
    patch: { xUrl?: string; xError?: string },
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

  private async writeError(kind: PickaxCrosspostKind, localId: string, message: string): Promise<void> {
    if (kind === 'post') {
      await this.prisma.post.updateMany({ where: { id: localId }, data: { xError: message } });
    } else {
      await this.prisma.article.updateMany({ where: { id: localId }, data: { xError: message } });
    }
  }

  private async loadPost(postId: string): Promise<LoadedPost | null> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: {
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
    const { poll, ...rest } = post;
    return { ...rest, hasPoll: Boolean(poll) };
  }
}
