import { ArticleCommentWriterService } from './article-comment-writer.service';
import { ArticleFeedService } from './article-feed.service';
import { LOGGED_IN_VIEW_WEIGHT } from '../views/view-tracking.utils';
import { easternDayKey } from '../../common/time/eastern-day-key';
import { JOBS } from '../jobs/jobs.constants';
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { assertPublishableText } from '../../common/moderation/content-filter';
import { Injectable, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { AppConfigService } from '../app/app-config.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { CacheService } from '../redis/cache.service';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { JobsService } from '../jobs/jobs.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { ArticleViewsService } from '../article-views/article-views.service';
import { BoardService } from '../board/board.service';
import { stableJsonHash } from '../redis/redis-keys';
import { toArticleDto, type ArticleWithAuthor } from '../../common/dto/article.dto';
import type { PostVisibility } from '@prisma/client';
import { slugifyArticleTitle } from '../../common/text/slugify';
import { ArticleEngagementService } from './article-engagement.service';
import { ArticleDiscoveryService } from './article-discovery.service';
import { ArticleCommentsService } from './article-comments.service';
import { toPage } from '../../common/pagination/page';
import { assertOwnerOrAdmin } from '../../common/access/assert-owner-or-admin';
import { syncTags } from './articles-tags';
import { articleIncludes, articleR2BaseUrl } from './articles.includes';
import { NOT_DELETED } from '../../common/prisma/where';

function extractExcerpt(tiptapJson: string, maxLength = 200): string {
  try {
    const doc = JSON.parse(tiptapJson);
    const texts: string[] = [];
    function walk(node: any) {
      if (!node) return;
      if (node.type === 'text' && node.text) texts.push(node.text);
      if (Array.isArray(node.content)) node.content.forEach(walk);
    }
    walk(doc);
    const plain = texts.join(' ').replace(/\s+/g, ' ').trim();
    return plain.length > maxLength ? plain.substring(0, maxLength).trimEnd() + '…' : plain;
  } catch {
    return '';
  }
}

const VERIFIED_ARTICLES_PER_DAY = 1;

@Injectable()
export class ArticlesService {
  readonly logger = new Logger(ArticlesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly viewer: ViewerContextService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly cache: CacheService,
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly jobs: JobsService,
    private readonly sideEffects: SideEffectsService,
    private readonly articleViews: ArticleViewsService,
    private readonly board: BoardService,
    private readonly comments: ArticleCommentsService,
    private readonly engagement: ArticleEngagementService,
    private readonly discovery: ArticleDiscoveryService,
    private readonly feed: ArticleFeedService,
    private readonly commentWriter: ArticleCommentWriterService,
  ) {}

  private async resolveSlug(title: string, excludeId?: string): Promise<string> {
    const base = slugifyArticleTitle(title) || 'article';
    let slug = base;
    let attempt = 0;
    while (true) {
      const existing = await this.prisma.article.findFirst({
        where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
        select: { id: true },
      });
      if (!existing) return slug;
      attempt++;
      if (attempt > 100) {
        slug = `${base}-${Date.now()}`;
        return slug;
      }
      slug = `${base}-${attempt}`;
    }
  }

  async listTagSuggestions(q: string): Promise<Array<{ tag: string; label: string; count: number }>> {
    return this.discovery.listTagSuggestions(q);
  }

  // ─── List trending articles ──────────────────────────────────────────────────

  async listTrending(opts: { viewerUserId?: string | null; limit?: number; /** When the 7-day scored set is short, backfill from older published articles. */ fillIfShort?: boolean; includeBody?: boolean; }) {
    return this.discovery.listTrending(opts);
  }

  // ─── List published articles ────────────────────────────────────────────────

  async listPublished(opts: {
    viewerUserId?: string | null;
    limit?: number;
    cursor?: string | null;
    authorUsername?: string | null;
    sort?: 'new' | 'trending' | null;
    visibilityFilter?: PostVisibility | null;
    mine?: boolean | null;
    followingOnly?: boolean | null;
    tag?: string | null;
    /** When true (e.g. "More from this author"), include articles of all visibility tiers.
     *  Articles the viewer cannot access are returned with viewerCanAccess=false and stripped body/excerpt. */
    includeRestricted?: boolean | null;
    includeBody?: boolean | null;
  }) {
    const limit = Math.min(opts.limit ?? 20, 50);
    const sort = opts.sort ?? 'new';

    // Cache simple list requests (no mine/followingOnly/includeRestricted/authorUsername filters).
    const isCacheable =
      !opts.mine &&
      !opts.followingOnly &&
      !opts.includeRestricted &&
      !opts.authorUsername;

    if (isCacheable) {
      const feedVer = await this.cacheInvalidation.feedGlobalVersion();
      const paramsHash = stableJsonHash({
        endpoint: 'articles:list',
        sort,
        limit,
        cursor: opts.cursor ?? null,
        visibilityFilter: opts.visibilityFilter ?? null,
        tag: opts.tag ?? null,
        includeBody: opts.includeBody ?? false,
        viewerUserId: opts.viewerUserId ?? null,
      });
      const cacheKey = `cache:articles:list:v${feedVer}:${paramsHash}`;

      const cached = await this.cache.getOrSetJson<{ articles: unknown[]; nextCursor: string | null }>({
        enabled: true,
        key: cacheKey,
        ttlSeconds: 60,
        compute: () => this._listPublishedRaw(opts, limit, sort),
      });
      return cached;
    }

    return this._listPublishedRaw(opts, limit, sort);
  }

  async _listPublishedRaw(opts: { viewerUserId?: string | null; limit?: number; cursor?: string | null; [key: string]: unknown; }, limit?: number, sort?: string) {
    return this.feed.listPublishedRaw(opts as never, limit as never, sort as never);
  }

  // ─── List user drafts ────────────────────────────────────────────────────────

  async listDrafts(opts: {
    userId: string;
    limit?: number;
    cursor?: string | null;
    visibilityFilter?: PostVisibility | null;
  }) {
    const limit = Math.min(opts.limit ?? 20, 50);
    const articles = await this.prisma.article.findMany({
      where: {
        authorId: opts.userId,
        isDraft: true,
        ...NOT_DELETED,
        ...(opts.visibilityFilter ? { visibility: opts.visibilityFilter } : {}),
        ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
      },
      orderBy: [{ lastSavedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: articleIncludes(false, false),
    }) as ArticleWithAuthor[];

    const { items: items, nextCursor: nextCursor } = toPage(articles, limit, (r) => r.id);
    return {
      articles: items.map((a) => toArticleDto(a, articleR2BaseUrl(this.appConfig))),
      nextCursor,
    };
  }

  // ─── Get single article ──────────────────────────────────────────────────────

  async getById(id: string, viewerUserId?: string | null) {
    const article = await this.prisma.article.findUnique({
      where: { id },
      include: articleIncludes(true, true, viewerUserId),
    }) as ArticleWithAuthor | null;

    if (!article || article.deletedAt) throw new NotFoundException('Article not found.');

    // Drafts only visible to author
    if (article.isDraft && article.authorId !== viewerUserId) {
      throw new NotFoundException('Article not found.');
    }

    const viewerHasBoosted = viewerUserId ? (article.boosts?.length ?? 0) > 0 : false;
    const viewed = await this.articleViews.viewerViewedArticleIds(viewerUserId, [article.id]);
    const viewerHasViewed = viewerUserId ? viewed.has(article.id) : undefined;

    // Visibility gating for published articles: return a stripped preview instead of 404
    // so the frontend can render a gated view (blurred thumbnail + upgrade CTA).
    if (!article.isDraft) {
      const viewerCtx = viewerUserId ? await this.viewer.getViewer(viewerUserId) : null;
      const allowed = this.viewer.allowedPostVisibilities(viewerCtx);
      const viewerCanAccess = allowed.includes(article.visibility) || article.authorId === viewerUserId;
      return toArticleDto(article, articleR2BaseUrl(this.appConfig), {
        viewerUserId,
        viewerHasBoosted,
        viewerHasViewed,
        viewerCanAccess,
      });
    }

    return toArticleDto(article, articleR2BaseUrl(this.appConfig), {
      viewerUserId,
      viewerHasBoosted,
      viewerHasViewed,
      viewerCanAccess: true,
    });
  }

  // ─── Create draft ────────────────────────────────────────────────────────────

  async create(userId: string, data: { title?: string; visibility?: PostVisibility }) {
    const viewerCtx = await this.viewer.getViewerOrThrow(userId);
    if (!this.viewer.isVerified(viewerCtx) && !this.viewer.isPremium(viewerCtx)) {
      throw new ForbiddenException('Verify your account to create articles.');
    }

    const requestedVisibility = data.visibility ?? 'public';
    const allowedVisibilities = this.viewer.allowedPostVisibilities(viewerCtx);
    if (!allowedVisibilities.includes(requestedVisibility)) {
      if (requestedVisibility === 'premiumOnly') {
        throw new ForbiddenException('Upgrade to premium to create premium-only articles.');
      }
      throw new ForbiddenException('You do not have permission to create articles with this visibility.');
    }

    // Allow empty title for drafts; only publish enforces a non-empty title
    const title = (data.title ?? '').trim();
    const slug = await this.resolveSlug(title || 'draft');

    const article = await this.prisma.article.create({
      data: {
        authorId: userId,
        title,
        slug,
        visibility: requestedVisibility,
        isDraft: true,
        lastSavedAt: new Date(),
      },
      include: articleIncludes(false, false),
    }) as ArticleWithAuthor;

    return toArticleDto(article, articleR2BaseUrl(this.appConfig));
  }

  // ─── Auto-save / update draft ────────────────────────────────────────────────

  async save(
    userId: string,
    articleId: string,
    data: { title?: string; body?: string; thumbnailR2Key?: string | null; visibility?: PostVisibility; tags?: string[] },
  ) {
    const article = await this.prisma.article.findUnique({ where: { id: articleId } });
    if (!article || article.deletedAt) throw new NotFoundException('Article not found.');
    assertOwnerOrAdmin({ userId }, article.authorId, 'Not your article.');

    if (data.visibility !== undefined) {
      const viewerCtx = await this.viewer.getViewerOrThrow(userId);
      const allowedVisibilities = this.viewer.allowedPostVisibilities(viewerCtx);
      if (!allowedVisibilities.includes(data.visibility)) {
        if (data.visibility === 'premiumOnly') {
          throw new ForbiddenException('Upgrade to premium to create premium-only articles.');
        }
        throw new ForbiddenException('You do not have permission to set this visibility.');
      }
    }

    const newTitle = typeof data.title === 'string' ? data.title.trim() || article.title : article.title;
    const newSlug =
      typeof data.title === 'string' && data.title.trim() !== article.title
        ? await this.resolveSlug(newTitle, articleId)
        : article.slug;
    const newBody = typeof data.body === 'string' ? data.body : article.body;
    const excerpt = extractExcerpt(newBody);
    assertPublishableText(newTitle, extractExcerpt(newBody, 100000));

    const updated = await this.prisma.article.update({
      where: { id: articleId },
      data: {
        title: newTitle,
        slug: newSlug,
        body: newBody,
        excerpt: excerpt || null,
        thumbnailR2Key:
          typeof data.thumbnailR2Key !== 'undefined' ? data.thumbnailR2Key : article.thumbnailR2Key,
        visibility: data.visibility ?? article.visibility,
        lastSavedAt: new Date(),
        // Only mark as edited if the article was already published.
        ...(article.publishedAt ? { editedAt: new Date() } : {}),
      },
      include: articleIncludes(false, false),
    }) as ArticleWithAuthor;

    if (updated.publishedAt && (updated.title !== article.title || updated.visibility !== article.visibility)) {
      await this.board.syncArticleThread(articleId, { title: updated.title, visibility: updated.visibility });
    }

    // Sync tags if provided (null/undefined = leave unchanged).
    if (Array.isArray(data.tags)) {
      await syncTags(this.prisma, articleId, data.tags);
      updated.tags = await this.prisma.articleTag.findMany({
        where: { articleId },
        select: { tag: true, label: true },
        orderBy: { createdAt: 'asc' },
      });
    }

    return toArticleDto(updated, articleR2BaseUrl(this.appConfig));
  }

  // ─── Publish ─────────────────────────────────────────────────────────────────

  async publish(userId: string, articleId: string, opts: { postToBoard?: boolean; shareToFeed?: boolean; crosspost?: { pickax?: 'link' | 'native'; x?: 'link' | 'native' } } = {}) {
    const article = await this.prisma.article.findUnique({ where: { id: articleId } });
    if (!article || article.deletedAt) throw new NotFoundException('Article not found.');
    assertOwnerOrAdmin({ userId }, article.authorId, 'Not your article.');
    if (!article.title.trim()) throw new BadRequestException('Article must have a title before publishing.');

    const viewerCtx = await this.viewer.getViewerOrThrow(userId);
    if (!this.viewer.isVerified(viewerCtx) && !this.viewer.isPremium(viewerCtx)) {
      throw new ForbiddenException('Verify your account to publish articles.');
    }

    const allowedVisibilities = this.viewer.allowedPostVisibilities(viewerCtx);
    if (!allowedVisibilities.includes(article.visibility)) {
      throw new ForbiddenException("This article's visibility is not available on your current plan.");
    }

    const isFirstPublish = !article.publishedAt;

    // Verified non-premium: 1 first-publish per Eastern calendar day
    if (isFirstPublish && !this.viewer.isPremium(viewerCtx)) {
      const todayKey = easternDayKey(new Date());
      // 36h lookback covers any ET offset; filter in memory by day key
      const windowStart = new Date(Date.now() - 36 * 60 * 60 * 1000);
      const recentPublished = await this.prisma.article.findMany({
        where: { authorId: userId, publishedAt: { gte: windowStart }, ...NOT_DELETED, id: { not: articleId } },
        select: { publishedAt: true },
      });
      const todayCount = recentPublished.filter(
        (a) => a.publishedAt !== null && easternDayKey(a.publishedAt) === todayKey,
      ).length;
      if (todayCount >= VERIFIED_ARTICLES_PER_DAY) {
        throw new HttpException(
          'You can publish 1 article per day. Upgrade to Premium for unlimited.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const published = await tx.article.update({
        where: { id: articleId },
        data: {
          isDraft: false,
          crosspostChoices: opts.crosspost,
          publishedAt: article.publishedAt ?? new Date(),
          editedAt: article.publishedAt ? new Date() : null,
          lastSavedAt: new Date(),
        },
        include: articleIncludes(true, true, userId),
      }) as ArticleWithAuthor;

      // Seed author self-view synchronously so publish response reflects at least 1 view.
      if (isFirstPublish) {
        const seededView = await tx.articleView.createMany({
          data: [{ articleId, userId }],
          skipDuplicates: true,
        });
        if (seededView.count > 0) {
          const updatedCounts = await tx.article.update({
            where: { id: articleId },
            data: {
              viewCount: { increment: 1 },
              totalViewCount: { increment: 1 },
              weightedViewCount: { increment: LOGGED_IN_VIEW_WEIGHT },
            },
            select: { viewCount: true, totalViewCount: true, weightedViewCount: true },
          });
          published.viewCount = updatedCounts.viewCount;
          published.totalViewCount = updatedCounts.totalViewCount;
          published.weightedViewCount = updatedCounts.weightedViewCount;
        }
      }
      return published;
    });

    if (isFirstPublish) {
      await this.crossPostToBoard(userId, updated, opts);
    }

    // Fire follower notifications only on first publish. The fan-out scales with the author's
    // follower count, so it runs on the side-effects queue rather than in this process.
    if (isFirstPublish) {
      this.sideEffects.dispatch(
        'article.published',
        { articleId, authorUserId: userId },
        { jobId: `article-published-${articleId}` },
      );
    }

    void this.cacheInvalidation.bumpFeedGlobal().catch(() => undefined);

    // Notify the WebSub hub so subscribers get real-time feed updates.
    void this.pingWebsubHub(updated.author?.username ?? null).catch(() => undefined);

    // Enqueue follower article emails on first publish.
    if (isFirstPublish) {
      this.jobs
        .enqueue(JOBS.articlesFollowedArticleEmail, { articleId, authorUserId: userId })
        .catch((err) => {
          this.logger.warn(
            `[email] Failed to enqueue followed-article email job: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    return toArticleDto(updated, articleR2BaseUrl(this.appConfig), { viewerUserId: userId });
  }

  /** First publish: optionally start a Board thread for the article, remembering the author's choice. */
  async crossPostToBoard(
    userId: string,
    article: ArticleWithAuthor,
    opts: { postToBoard?: boolean; shareToFeed?: boolean },
  ) {
    const prefs = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { articlePostToBoardDefault: true, boardShareToFeedDefault: true },
    });
    const postToBoard = opts.postToBoard ?? prefs?.articlePostToBoardDefault ?? true;
    const shareToFeed = opts.shareToFeed ?? prefs?.boardShareToFeedDefault ?? false;
    if (typeof opts.postToBoard === 'boolean' || typeof opts.shareToFeed === 'boolean') {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(typeof opts.postToBoard === 'boolean' ? { articlePostToBoardDefault: opts.postToBoard } : {}),
          ...(postToBoard && typeof opts.shareToFeed === 'boolean' ? { boardShareToFeedDefault: opts.shareToFeed } : {}),
        },
      });
    }
    if (!postToBoard) return;
    const tags = await this.prisma.articleTag.findMany({ where: { articleId: article.id }, select: { tag: true }, take: 3 });
    try {
      await this.board.createArticleThread({
        userId,
        article: {
          id: article.id,
          title: article.title,
          excerpt: article.excerpt ?? null,
          visibility: article.visibility,
          commentCount: article.commentCount ?? 0,
        },
        tags: tags.map((t) => t.tag),
        showInFeed: shareToFeed,
      });
    } catch (err) {
      this.logger.warn(`[board] Article ${article.id} cross-post failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Unpublish ────────────────────────────────────────────────────────────────

  async unpublish(userId: string, articleId: string) {
    const article = await this.prisma.article.findUnique({ where: { id: articleId } });
    if (!article || article.deletedAt) throw new NotFoundException('Article not found.');
    assertOwnerOrAdmin({ userId }, article.authorId, 'Not your article.');

    // Fetch username before update for hub ping.
    const authorUser = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true } });

    const updated = await this.prisma.article.update({
      where: { id: articleId },
      data: { isDraft: true },
      include: articleIncludes(false, false),
    }) as ArticleWithAuthor;

    await this.board.syncArticleThread(articleId, { deleted: true });
    void this.cacheInvalidation.bumpFeedGlobal().catch(() => undefined);

    // Notify hub — feed content changed (article removed from public feed).
    void this.pingWebsubHub(authorUser?.username ?? null).catch(() => undefined);

    return toArticleDto(updated, articleR2BaseUrl(this.appConfig));
  }

  // ─── WebSub ──────────────────────────────────────────────────────────────────

  /**
   * Fire-and-forget WebSub hub notification so feed subscribers get real-time updates.
   * Pings the global articles feeds and (when username is known) the per-author feeds.
   * Failures are logged as warnings — never throw, never block the response.
   *
   * Hub: https://pubsubhubbub.appspot.com
   * Spec: https://www.w3.org/TR/websub/
   */
  async pingWebsubHub(authorUsername: string | null): Promise<void> {
    const siteUrl = this.appConfig.frontendBaseUrl()?.replace(/\/$/, '') ?? 'https://menofhunger.com';
    const hubUrl = 'https://pubsubhubbub.appspot.com/publish';

    const feedUrls = [
      `${siteUrl}/articles/feed.xml`,
      `${siteUrl}/articles/feed.atom`,
      `${siteUrl}/articles/feed.json`,
      ...(authorUsername
        ? [
            `${siteUrl}/u/${encodeURIComponent(authorUsername)}/articles/feed.xml`,
            `${siteUrl}/u/${encodeURIComponent(authorUsername)}/articles/feed.atom`,
            `${siteUrl}/u/${encodeURIComponent(authorUsername)}/articles/feed.json`,
          ]
        : []),
    ];

    for (const feedUrl of feedUrls) {
      try {
        const body = new URLSearchParams({ 'hub.mode': 'publish', 'hub.url': feedUrl }).toString();
        const res = await fetch(hubUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          this.logger.warn(`[websub] Hub ping failed for ${feedUrl}: HTTP ${res.status}`);
        }
      } catch (err) {
        this.logger.warn(
          `[websub] Hub ping error for ${feedUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ─── Delete ───────────────────────────────────────────────────────────────────

  async delete(userId: string, articleId: string) {
    const article = await this.prisma.article.findUnique({ where: { id: articleId } });
    if (!article || article.deletedAt) throw new NotFoundException('Article not found.');
    assertOwnerOrAdmin({ userId }, article.authorId, 'Not your article.');
    const deletedAt = new Date();
    await this.prisma.article.update({ where: { id: articleId }, data: { deletedAt } });
    await this.board.syncArticleThread(articleId, { deleted: true });
    this.presenceRealtime.emitArticlesLiveUpdated(articleId, {
      articleId,
      version: deletedAt.toISOString(),
      reason: 'article_deleted',
      patch: { deletedAt: deletedAt.toISOString() },
    });
    void this.cacheInvalidation.bumpFeedGlobal().catch(() => undefined);
    return { success: true };
  }

  // ─── Boost ────────────────────────────────────────────────────────────────────

  async boost(userId: string, articleId: string) {
    return this.engagement.boost(userId, articleId);
  }

  async unboost(userId: string, articleId: string) {
    return this.engagement.unboost(userId, articleId);
  }

  // ─── Reactions ────────────────────────────────────────────────────────────────

  async addReaction(userId: string, articleId: string, reactionId: string) {
    return this.engagement.addReaction(userId, articleId, reactionId);
  }

  async removeReaction(userId: string, articleId: string, reactionId: string) {
    return this.engagement.removeReaction(userId, articleId, reactionId);
  }

  // ─── Comments ─────────────────────────────────────────────────────────────────

  async listComments(opts: { articleId: string; viewerUserId?: string | null; limit?: number; cursor?: string | null; }) {
    return this.comments.listComments(opts);
  }

  async getComment(opts: { articleId: string; commentId: string; viewerUserId?: string | null; }) {
    return this.comments.getComment(opts);
  }

  async listCommentReplies(opts: { articleId: string; parentCommentId: string; viewerUserId?: string | null; limit?: number; cursor?: string | null; }) {
    return this.comments.listCommentReplies(opts);
  }

  async createComment(userId: string, articleId: string, data: { body: string; parentId?: string | null }) {
    return this.commentWriter.createArticleComment(userId, articleId, data);
  }

  async updateComment(userId: string, commentId: string, body: string) {
    return this.comments.updateComment(userId, commentId, body);
  }

  async deleteComment(userId: string, commentId: string) {
    return this.comments.deleteComment(userId, commentId);
  }

  async addCommentReaction(userId: string, commentId: string, reactionId: string) {
    return this.comments.addCommentReaction(userId, commentId, reactionId);
  }

  async removeCommentReaction(userId: string, commentId: string, reactionId: string) {
    return this.comments.removeCommentReaction(userId, commentId, reactionId);
  }

  // ─── Article share post ───────────────────────────────────────────────────────

  async createSharePost(userId: string, articleId: string, body: string, shareVisibility?: PostVisibility) {
    return this.engagement.createSharePost(userId, articleId, body, shareVisibility);
  }

  // ─── Internal ─────────────────────────────────────────────────────────────────


}
