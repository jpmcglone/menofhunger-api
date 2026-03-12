import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { AppConfigService } from '../app/app-config.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { ArticleViewsService } from '../article-views/article-views.service';
import {
  toArticleDto,
  toArticleCommentDto,
  toArticleSharePreviewDto,
  buildReactionSummaries,
  articleAuthorInclude,
  type ArticleWithAuthor,
  type ArticleCommentWithAuthorAndReactions,
} from '../../common/dto/article.dto';
import { toPostDto } from '../../common/dto/post.dto';
import { findReactionById } from '../../common/constants/reactions';
import { parseMentionsFromBody } from '../../common/mentions/mention-regex';
import type { PostVisibility } from '@prisma/client';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80);
}

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

@Injectable()
export class ArticlesService {
  private readonly logger = new Logger(ArticlesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly viewer: ViewerContextService,
    private readonly appConfig: AppConfigService,
    private readonly notifications: NotificationsService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly articleViews: ArticleViewsService,
  ) {}

  private get r2BaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  private async resolveSlug(title: string, excludeId?: string): Promise<string> {
    const base = slugify(title) || 'article';
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

  private articleAuthorSelect() {
    return { select: articleAuthorInclude };
  }

  private articleIncludes(includeReactions = true, includeBoosts = true, viewerUserId?: string | null) {
    return {
      author: this.articleAuthorSelect(),
      ...(includeReactions ? { reactions: true } : {}),
      ...(includeBoosts ? {
        boosts: viewerUserId
          ? { where: { userId: viewerUserId }, select: { userId: true }, take: 1 }
          : false,
      } : {}),
    };
  }

  // ─── List trending articles ──────────────────────────────────────────────────

  async listTrending(opts: { viewerUserId?: string | null; limit?: number }) {
    const limit = Math.min(opts.limit ?? 5, 20);
    const viewerCtx = opts.viewerUserId ? await this.viewer.getViewer(opts.viewerUserId) : null;
    const allowedVisibilities = this.viewer.allowedPostVisibilities(viewerCtx);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const articles = await this.prisma.article.findMany({
      where: {
        isDraft: false,
        deletedAt: null,
        publishedAt: { gte: sevenDaysAgo },
        visibility: { in: allowedVisibilities },
        trendingScore: { not: null },
      },
      orderBy: [{ trendingScore: 'desc' }, { publishedAt: 'desc' }],
      take: limit,
      include: this.articleIncludes(true, true, opts.viewerUserId),
    }) as ArticleWithAuthor[];

    return articles.map((a) =>
      toArticleDto(a, this.r2BaseUrl, {
        viewerUserId: opts.viewerUserId,
        viewerHasBoosted: opts.viewerUserId ? (a.boosts?.length ?? 0) > 0 : false,
      }),
    );
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
    /** When true (e.g. "More from this author"), include articles of all visibility tiers.
     *  Articles the viewer cannot access are returned with viewerCanAccess=false and stripped body/excerpt. */
    includeRestricted?: boolean | null;
  }) {
    const limit = Math.min(opts.limit ?? 20, 50);
    const sort = opts.sort ?? 'new';
    const viewerCtx = opts.viewerUserId ? await this.viewer.getViewer(opts.viewerUserId) : null;
    const allowedVisibilities = this.viewer.allowedPostVisibilities(viewerCtx);

    // followingOnly with no authenticated viewer returns nothing
    if (opts.followingOnly && !opts.viewerUserId) {
      return { articles: [], nextCursor: null };
    }

    const effectiveVisibilities =
      opts.visibilityFilter && allowedVisibilities.includes(opts.visibilityFilter)
        ? [opts.visibilityFilter]
        : allowedVisibilities;

    const authorFilter = opts.mine
      ? { authorId: opts.viewerUserId ?? '__none__' }
      : opts.authorUsername
        ? { author: { username: opts.authorUsername } }
        : opts.followingOnly && opts.viewerUserId
          ? { author: { followers: { some: { followerId: opts.viewerUserId } } } }
          : {};

    // When includeRestricted is set we normally skip the visibility WHERE so all tiers appear.
    // However, if the caller also provides an explicit visibilityFilter (e.g. the user picked
    // "public only"), honour that filter even in restricted-include mode.
    const visibilityFilter = opts.includeRestricted
      ? opts.visibilityFilter
        ? { visibility: opts.visibilityFilter }
        : {}
      : { visibility: { in: effectiveVisibilities } };

    const toDto = (a: ArticleWithAuthor) => {
      const viewerCanAccess =
        allowedVisibilities.includes(a.visibility) || a.authorId === opts.viewerUserId;
      return toArticleDto(a, this.r2BaseUrl, {
        viewerUserId: opts.viewerUserId,
        viewerHasBoosted: opts.viewerUserId ? (a.boosts?.length ?? 0) > 0 : false,
        viewerCanAccess,
      });
    };

    if (sort === 'trending') {
      // Offset-based for trending (score changes, cursor-based is unreliable).
      // Include all articles regardless of trendingScore; nulls sort last explicitly (Postgres defaults to NULLS FIRST with DESC).
      const skip = opts.cursor ? parseInt(opts.cursor, 10) : 0;
      const articles = await this.prisma.article.findMany({
        where: {
          isDraft: false,
          deletedAt: null,
          publishedAt: { not: null },
          ...visibilityFilter,
          ...authorFilter,
        },
        orderBy: [{ trendingScore: { sort: 'desc', nulls: 'last' } }, { publishedAt: 'desc' }],
        skip,
        take: limit + 1,
        include: this.articleIncludes(true, true, opts.viewerUserId),
      }) as ArticleWithAuthor[];

      const hasMore = articles.length > limit;
      const items = hasMore ? articles.slice(0, limit) : articles;
      const nextCursor = hasMore ? String(skip + limit) : null;

      return { articles: items.map(toDto), nextCursor };
    }

    // Default: newest first, cursor-based
    const articles = await this.prisma.article.findMany({
      where: {
        isDraft: false,
        deletedAt: null,
        publishedAt: { not: null },
        ...visibilityFilter,
        ...authorFilter,
        ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: this.articleIncludes(true, true, opts.viewerUserId),
    }) as ArticleWithAuthor[];

    const hasMore = articles.length > limit;
    const items = hasMore ? articles.slice(0, limit) : articles;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    return { articles: items.map(toDto), nextCursor };
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
        deletedAt: null,
        ...(opts.visibilityFilter ? { visibility: opts.visibilityFilter } : {}),
        ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
      },
      orderBy: [{ lastSavedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: this.articleIncludes(false, false),
    }) as ArticleWithAuthor[];

    const hasMore = articles.length > limit;
    const items = hasMore ? articles.slice(0, limit) : articles;
    const nextCursor = hasMore ? items[items.length - 1].id : null;
    return {
      articles: items.map((a) => toArticleDto(a, this.r2BaseUrl)),
      nextCursor,
    };
  }

  // ─── Get single article ──────────────────────────────────────────────────────

  async getById(id: string, viewerUserId?: string | null) {
    const article = await this.prisma.article.findUnique({
      where: { id },
      include: this.articleIncludes(true, true, viewerUserId),
    }) as ArticleWithAuthor | null;

    if (!article || article.deletedAt) throw new NotFoundException('Article not found.');

    // Drafts only visible to author
    if (article.isDraft && article.authorId !== viewerUserId) {
      throw new NotFoundException('Article not found.');
    }

    const viewerHasBoosted = viewerUserId ? (article.boosts?.length ?? 0) > 0 : false;

    // Visibility gating for published articles: return a stripped preview instead of 404
    // so the frontend can render a gated view (blurred thumbnail + upgrade CTA).
    if (!article.isDraft) {
      const viewerCtx = viewerUserId ? await this.viewer.getViewer(viewerUserId) : null;
      const allowed = this.viewer.allowedPostVisibilities(viewerCtx);
      const viewerCanAccess = allowed.includes(article.visibility) || article.authorId === viewerUserId;
      return toArticleDto(article, this.r2BaseUrl, { viewerUserId, viewerHasBoosted, viewerCanAccess });
    }

    return toArticleDto(article, this.r2BaseUrl, { viewerUserId, viewerHasBoosted, viewerCanAccess: true });
  }

  // ─── Create draft ────────────────────────────────────────────────────────────

  async create(userId: string, data: { title?: string; visibility?: PostVisibility }) {
    const viewerCtx = await this.viewer.getViewerOrThrow(userId);
    if (!this.viewer.isPremium(viewerCtx)) {
      throw new ForbiddenException('Article creation requires a premium subscription.');
    }

    // Allow empty title for drafts; only publish enforces a non-empty title
    const title = (data.title ?? '').trim();
    const slug = await this.resolveSlug(title || 'draft');

    const article = await this.prisma.article.create({
      data: {
        authorId: userId,
        title,
        slug,
        visibility: data.visibility ?? 'public',
        isDraft: true,
        lastSavedAt: new Date(),
      },
      include: this.articleIncludes(false, false),
    }) as ArticleWithAuthor;

    return toArticleDto(article, this.r2BaseUrl);
  }

  // ─── Auto-save / update draft ────────────────────────────────────────────────

  async save(
    userId: string,
    articleId: string,
    data: { title?: string; body?: string; thumbnailR2Key?: string | null; visibility?: PostVisibility },
  ) {
    const article = await this.prisma.article.findUnique({ where: { id: articleId } });
    if (!article || article.deletedAt) throw new NotFoundException('Article not found.');
    if (article.authorId !== userId) throw new ForbiddenException('Not your article.');

    const newTitle = typeof data.title === 'string' ? data.title.trim() || article.title : article.title;
    const newSlug =
      typeof data.title === 'string' && data.title.trim() !== article.title
        ? await this.resolveSlug(newTitle, articleId)
        : article.slug;
    const newBody = typeof data.body === 'string' ? data.body : article.body;
    const excerpt = extractExcerpt(newBody);

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
      },
      include: this.articleIncludes(false, false),
    }) as ArticleWithAuthor;

    return toArticleDto(updated, this.r2BaseUrl);
  }

  // ─── Publish ─────────────────────────────────────────────────────────────────

  async publish(userId: string, articleId: string) {
    const article = await this.prisma.article.findUnique({ where: { id: articleId } });
    if (!article || article.deletedAt) throw new NotFoundException('Article not found.');
    if (article.authorId !== userId) throw new ForbiddenException('Not your article.');
    if (!article.title.trim()) throw new BadRequestException('Article must have a title before publishing.');

    const isFirstPublish = !article.publishedAt;

    const updated = await this.prisma.article.update({
      where: { id: articleId },
      data: {
        isDraft: false,
        publishedAt: article.publishedAt ?? new Date(),
        editedAt: article.publishedAt ? new Date() : null,
        lastSavedAt: new Date(),
      },
      include: this.articleIncludes(true, true, userId),
    }) as ArticleWithAuthor;

    // Count the author as the first viewer on first publish.
    if (isFirstPublish) {
      this.articleViews.markViewed(userId, articleId).catch((err) => {
        this.logger.warn(`[article-views] Failed to seed author view on publish: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    // Fire follower notifications only on first publish.
    if (isFirstPublish) {
      setImmediate(async () => {
        try {
          const follows = await this.prisma.follow.findMany({
            where: { followingId: userId },
            select: {
              followerId: true,
              follower: { select: { verifiedStatus: true, premium: true, premiumPlus: true } },
            },
          });

          const titleSnippet = updated.title.length > 80 ? updated.title.slice(0, 79) + '…' : updated.title;

          for (const f of follows) {
            const recipientUserId = f.followerId;
            if (!recipientUserId || recipientUserId === userId) continue;

            if (updated.visibility === 'verifiedOnly') {
              const vs = f.follower?.verifiedStatus ?? 'none';
              if (!vs || vs === 'none') continue;
            }
            if (updated.visibility === 'premiumOnly') {
              if (!f.follower?.premium && !f.follower?.premiumPlus) continue;
            }

            this.notifications
              .create({
                recipientUserId,
                kind: 'followed_article',
                actorUserId: userId,
                subjectArticleId: articleId,
                subjectUserId: userId,
                body: titleSnippet || undefined,
              })
              .catch((err) => {
                this.logger.warn(
                  `[notifications] Failed to create followed-article notification: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
          }
        } catch (err) {
          this.logger.warn(
            `[notifications] Failed to query followers for followed-article notifications: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    }

    return toArticleDto(updated, this.r2BaseUrl, { viewerUserId: userId });
  }

  // ─── Unpublish ────────────────────────────────────────────────────────────────

  async unpublish(userId: string, articleId: string) {
    const article = await this.prisma.article.findUnique({ where: { id: articleId } });
    if (!article || article.deletedAt) throw new NotFoundException('Article not found.');
    if (article.authorId !== userId) throw new ForbiddenException('Not your article.');

    const updated = await this.prisma.article.update({
      where: { id: articleId },
      data: { isDraft: true },
      include: this.articleIncludes(false, false),
    }) as ArticleWithAuthor;

    return toArticleDto(updated, this.r2BaseUrl);
  }

  // ─── Delete ───────────────────────────────────────────────────────────────────

  async delete(userId: string, articleId: string) {
    const article = await this.prisma.article.findUnique({ where: { id: articleId } });
    if (!article || article.deletedAt) throw new NotFoundException('Article not found.');
    if (article.authorId !== userId) throw new ForbiddenException('Not your article.');
    await this.prisma.article.update({ where: { id: articleId }, data: { deletedAt: new Date() } });
    return { success: true };
  }

  // ─── Boost ────────────────────────────────────────────────────────────────────

  async boost(userId: string, articleId: string) {
    await this.assertArticleAccessible(articleId, userId);
    try {
      await this.prisma.$transaction([
        this.prisma.articleBoost.create({ data: { articleId, userId } }),
        this.prisma.article.update({ where: { id: articleId }, data: { boostCount: { increment: 1 } } }),
      ]);
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException('Already boosted.');
      throw e;
    }
    const afterBoost = await this.prisma.article.findUnique({ where: { id: articleId }, select: { boostCount: true } });
    if (afterBoost) {
      this.presenceRealtime.emitArticlesLiveUpdated(articleId, {
        articleId,
        version: new Date().toISOString(),
        reason: 'boostCount',
        patch: { boostCount: afterBoost.boostCount },
      });
    }
    setImmediate(async () => {
      try {
        const article = await this.prisma.article.findUnique({
          where: { id: articleId },
          select: { authorId: true, title: true },
        });
        if (!article || article.authorId === userId) return;
        await this.notifications.create({
          recipientUserId: article.authorId,
          kind: 'boost',
          actorUserId: userId,
          subjectArticleId: articleId,
          title: 'boosted your article',
          body: article.title?.trim() ? article.title.trim().slice(0, 150) : null,
        });
      } catch (err) {
        this.logger.warn(
          `[notifications] Failed to create article boost notification: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    return { boosted: true };
  }

  async unboost(userId: string, articleId: string) {
    const boost = await this.prisma.articleBoost.findUnique({
      where: { articleId_userId: { articleId, userId } },
    });
    if (!boost) throw new NotFoundException('Boost not found.');
    await this.prisma.$transaction([
      this.prisma.articleBoost.delete({ where: { articleId_userId: { articleId, userId } } }),
      this.prisma.article.update({
        where: { id: articleId },
        data: { boostCount: { decrement: 1 } },
      }),
    ]);
    const afterUnboost = await this.prisma.article.findUnique({ where: { id: articleId }, select: { boostCount: true } });
    if (afterUnboost) {
      this.presenceRealtime.emitArticlesLiveUpdated(articleId, {
        articleId,
        version: new Date().toISOString(),
        reason: 'boostCount',
        patch: { boostCount: afterUnboost.boostCount },
      });
    }
    return { boosted: false };
  }

  // ─── Reactions ────────────────────────────────────────────────────────────────

  async addReaction(userId: string, articleId: string, reactionId: string) {
    const reaction = findReactionById(reactionId);
    if (!reaction) throw new BadRequestException('Invalid reaction.');
    await this.assertArticleAccessible(articleId, userId);
    try {
      await this.prisma.articleReaction.create({
        data: { articleId, userId, reactionId: reaction.id, emoji: reaction.emoji },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException('Already reacted with this emoji.');
      throw e;
    }
    setImmediate(async () => {
      try {
        const allReactions = await this.prisma.articleReaction.findMany({ where: { articleId } });
        this.presenceRealtime.emitArticlesLiveUpdated(articleId, {
          articleId,
          version: new Date().toISOString(),
          reason: 'reactions',
          patch: { reactions: buildReactionSummaries(allReactions, userId) },
        });
      } catch { /* best-effort */ }
    });
    setImmediate(async () => {
      try {
        const article = await this.prisma.article.findUnique({
          where: { id: articleId },
          select: { authorId: true, title: true },
        });
        if (!article || article.authorId === userId) return;
        await this.notifications.create({
          recipientUserId: article.authorId,
          kind: 'generic',
          actorUserId: userId,
          subjectArticleId: articleId,
          title: `reacted to your article`,
          body: reaction.emoji,
        });
      } catch (err) {
        this.logger.warn(
          `[notifications] Failed to create article reaction notification: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    return { reactionId: reaction.id, emoji: reaction.emoji };
  }

  async removeReaction(userId: string, articleId: string, reactionId: string) {
    const existing = await this.prisma.articleReaction.findUnique({
      where: { articleId_userId_reactionId: { articleId, userId, reactionId } },
    });
    if (!existing) throw new NotFoundException('Reaction not found.');
    await this.prisma.articleReaction.delete({
      where: { articleId_userId_reactionId: { articleId, userId, reactionId } },
    });
    setImmediate(async () => {
      try {
        const allReactions = await this.prisma.articleReaction.findMany({ where: { articleId } });
        this.presenceRealtime.emitArticlesLiveUpdated(articleId, {
          articleId,
          version: new Date().toISOString(),
          reason: 'reactions',
          patch: { reactions: buildReactionSummaries(allReactions, userId) },
        });
      } catch { /* best-effort */ }
    });
    return { success: true };
  }

  // ─── Comments ─────────────────────────────────────────────────────────────────

  private commentIncludes() {
    return {
      author: this.articleAuthorSelect(),
      reactions: true,
      replies: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' as const },
        take: 3,
        include: {
          author: this.articleAuthorSelect(),
          reactions: true,
        },
      },
    };
  }

  private commentLeafIncludes() {
    return {
      author: this.articleAuthorSelect(),
      reactions: true,
    };
  }

  async listComments(opts: {
    articleId: string;
    viewerUserId?: string | null;
    limit?: number;
    cursor?: string | null;
  }) {
    await this.assertArticleAccessible(opts.articleId, opts.viewerUserId);
    const limit = Math.min(opts.limit ?? 20, 50);

    const comments = await this.prisma.articleComment.findMany({
      where: {
        articleId: opts.articleId,
        parentId: null,
        deletedAt: null,
        ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      include: this.commentIncludes(),
    }) as ArticleCommentWithAuthorAndReactions[];

    const hasMore = comments.length > limit;
    const items = hasMore ? comments.slice(0, limit) : comments;
    const nextCursor = hasMore ? items[items.length - 1].id : null;
    return {
      comments: items.map((c) => toArticleCommentDto(c, this.r2BaseUrl, { viewerUserId: opts.viewerUserId })),
      nextCursor,
    };
  }

  async listCommentReplies(opts: {
    articleId: string;
    parentCommentId: string;
    viewerUserId?: string | null;
    limit?: number;
    cursor?: string | null;
  }) {
    await this.assertArticleAccessible(opts.articleId, opts.viewerUserId);
    const parent = await this.prisma.articleComment.findUnique({
      where: { id: opts.parentCommentId },
      select: { id: true, articleId: true, parentId: true, deletedAt: true },
    });
    if (!parent || parent.deletedAt) throw new NotFoundException('Comment not found.');
    if (parent.articleId !== opts.articleId) throw new NotFoundException('Comment not found.');
    if (parent.parentId !== null) throw new BadRequestException('Replies can only be loaded for top-level comments.');

    const limit = Math.min(opts.limit ?? 20, 50);
    const replies = await this.prisma.articleComment.findMany({
      where: {
        articleId: opts.articleId,
        parentId: opts.parentCommentId,
        deletedAt: null,
        ...(opts.cursor ? { id: { gt: opts.cursor } } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: this.commentLeafIncludes(),
    }) as ArticleCommentWithAuthorAndReactions[];

    const hasMore = replies.length > limit;
    const items = hasMore ? replies.slice(0, limit) : replies;
    const nextCursor = hasMore ? items[items.length - 1].id : null;
    return {
      comments: items.map((c) => toArticleCommentDto(c, this.r2BaseUrl, { viewerUserId: opts.viewerUserId })),
      nextCursor,
    };
  }

  async createComment(
    userId: string,
    articleId: string,
    data: { body: string; parentId?: string | null },
  ) {
    const viewerCtx = await this.viewer.getViewerOrThrow(userId);
    if (!this.viewer.isVerified(viewerCtx) && !this.viewer.isPremium(viewerCtx)) {
      throw new ForbiddenException('Verified membership required to comment.');
    }
    await this.assertArticleAccessible(articleId, userId);

    if (data.parentId) {
      const parent = await this.prisma.articleComment.findUnique({ where: { id: data.parentId } });
      if (!parent || parent.deletedAt) throw new NotFoundException('Parent comment not found.');
      if (parent.articleId !== articleId) throw new BadRequestException('Parent comment belongs to a different article.');
      if (parent.parentId !== null) throw new BadRequestException('Cannot reply more than one level deep.');
    }

    let newCommentCount: number | null = null;
    const comment = await this.prisma.$transaction(async (tx) => {
      const c = await tx.articleComment.create({
        data: {
          articleId,
          authorId: userId,
          body: data.body.trim(),
          parentId: data.parentId ?? null,
        },
        include: this.commentIncludes(),
      });
      if (data.parentId) {
        await tx.articleComment.update({
          where: { id: data.parentId },
          data: { replyCount: { increment: 1 } },
        });
      } else {
        const updated = await tx.article.update({
          where: { id: articleId },
          data: { commentCount: { increment: 1 } },
          select: { commentCount: true },
        });
        newCommentCount = updated.commentCount;
      }
      return c;
    }) as ArticleCommentWithAuthorAndReactions;

    const commentDto = toArticleCommentDto(comment, this.r2BaseUrl, { viewerUserId: userId });

    if (newCommentCount !== null) {
      this.presenceRealtime.emitArticlesLiveUpdated(articleId, {
        articleId,
        version: new Date().toISOString(),
        reason: 'commentCount',
        patch: { commentCount: newCommentCount },
      });
    }

    this.presenceRealtime.emitArticlesCommentAdded(articleId, { articleId, comment: commentDto });

    setImmediate(async () => {
      try {
        const bodySnippet = commentDto.body?.slice(0, 150) ?? null;
        const mentionUsernames = parseMentionsFromBody(commentDto.body ?? '');
        const mentionUsers = mentionUsernames.length
          ? await this.prisma.user.findMany({
              where: { username: { in: mentionUsernames } },
              select: { id: true },
            })
          : [];
        const mentionUserIds = new Set<string>(mentionUsers.map((u) => u.id));

        const art = await this.prisma.article.findUnique({ where: { id: articleId }, select: { authorId: true } });
        if (!art) return;

        const recipientId = data.parentId
          ? (await this.prisma.articleComment.findUnique({ where: { id: data.parentId }, select: { authorId: true } }))?.authorId ?? art.authorId
          : art.authorId;

        // Keep parity with post comment behavior: explicit @mentions take priority over comment notifications.
        if (recipientId !== userId && !mentionUserIds.has(recipientId)) {
          await this.notifications.create({
            recipientUserId: recipientId,
            kind: 'comment',
            actorUserId: userId,
            subjectArticleId: articleId,
            title: data.parentId ? 'replied to your comment' : 'commented on your article',
            body: bodySnippet,
          });
        }

        const mentionTitle = data.parentId
          ? 'mentioned you in an article reply'
          : 'mentioned you in an article comment';
        for (const mentionedUserId of mentionUserIds) {
          if (mentionedUserId === userId) continue;
          await this.notifications.create({
            recipientUserId: mentionedUserId,
            kind: 'mention',
            actorUserId: userId,
            subjectArticleId: articleId,
            title: mentionTitle,
            body: bodySnippet,
          });
        }
      } catch (err) {
        this.logger.warn(`[notifications] Failed to create article comment notification: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    return commentDto;
  }

  async updateComment(userId: string, commentId: string, body: string) {
    const comment = await this.prisma.articleComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deletedAt) throw new NotFoundException('Comment not found.');
    if (comment.authorId !== userId) throw new ForbiddenException('Not your comment.');

    const updated = await this.prisma.articleComment.update({
      where: { id: commentId },
      data: { body: body.trim(), editedAt: new Date() },
      include: this.commentIncludes(),
    }) as ArticleCommentWithAuthorAndReactions;

    const updatedDto = toArticleCommentDto(updated, this.r2BaseUrl, { viewerUserId: userId });
    this.presenceRealtime.emitArticlesCommentUpdated(comment.articleId, {
      articleId: comment.articleId,
      comment: updatedDto,
    });

    return updatedDto;
  }

  async deleteComment(userId: string, commentId: string) {
    const comment = await this.prisma.articleComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deletedAt) throw new NotFoundException('Comment not found.');
    if (comment.authorId !== userId) throw new ForbiddenException('Not your comment.');

    let newCommentCount: number | null = null;
    await this.prisma.$transaction(async (tx) => {
      await tx.articleComment.update({ where: { id: commentId }, data: { deletedAt: new Date() } });
      if (comment.parentId) {
        await tx.articleComment.update({
          where: { id: comment.parentId },
          data: { replyCount: { decrement: 1 } },
        });
        const parentAfter = await tx.articleComment.findUnique({ where: { id: comment.parentId }, select: { replyCount: true } });
        if (parentAfter && parentAfter.replyCount < 0) {
          await tx.articleComment.update({ where: { id: comment.parentId }, data: { replyCount: 0 } });
        }
      } else {
        await tx.$executeRaw`UPDATE "Article" SET "commentCount" = GREATEST(0, "commentCount" - 1) WHERE "id" = ${comment.articleId}`;
        const after = await tx.article.findUnique({ where: { id: comment.articleId }, select: { commentCount: true } });
        newCommentCount = after?.commentCount ?? 0;
      }
    });

    this.presenceRealtime.emitArticlesCommentDeleted(comment.articleId, {
      articleId: comment.articleId,
      commentId,
      parentId: comment.parentId,
    });

    if (newCommentCount !== null) {
      this.presenceRealtime.emitArticlesLiveUpdated(comment.articleId, {
        articleId: comment.articleId,
        version: new Date().toISOString(),
        reason: 'commentCount',
        patch: { commentCount: newCommentCount },
      });
    }

    return { success: true };
  }

  async addCommentReaction(userId: string, commentId: string, reactionId: string) {
    const reaction = findReactionById(reactionId);
    if (!reaction) throw new BadRequestException('Invalid reaction.');
    const comment = await this.prisma.articleComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deletedAt) throw new NotFoundException('Comment not found.');
    await this.assertArticleAccessible(comment.articleId, userId);
    try {
      await this.prisma.articleCommentReaction.create({
        data: { commentId, userId, reactionId: reaction.id, emoji: reaction.emoji },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException('Already reacted with this emoji.');
      throw e;
    }

    setImmediate(async () => {
      try {
        const reactions = await this.prisma.articleCommentReaction.findMany({ where: { commentId } });
        this.presenceRealtime.emitArticlesCommentReactionChanged(comment.articleId, {
          articleId: comment.articleId,
          commentId,
          parentId: comment.parentId,
          reactions: buildReactionSummaries(reactions, userId),
        });
      } catch { /* best-effort */ }
    });

    return { reactionId: reaction.id, emoji: reaction.emoji };
  }

  async removeCommentReaction(userId: string, commentId: string, reactionId: string) {
    const existing = await this.prisma.articleCommentReaction.findUnique({
      where: { commentId_userId_reactionId: { commentId, userId, reactionId } },
    });
    if (!existing) throw new NotFoundException('Reaction not found.');

    const comment = await this.prisma.articleComment.findUnique({ where: { id: commentId } });

    await this.prisma.articleCommentReaction.delete({
      where: { commentId_userId_reactionId: { commentId, userId, reactionId } },
    });

    if (comment) {
      setImmediate(async () => {
        try {
          const reactions = await this.prisma.articleCommentReaction.findMany({ where: { commentId } });
          this.presenceRealtime.emitArticlesCommentReactionChanged(comment.articleId, {
            articleId: comment.articleId,
            commentId,
            parentId: comment.parentId,
            reactions: buildReactionSummaries(reactions, userId),
          });
        } catch { /* best-effort */ }
      });
    }

    return { success: true };
  }

  // ─── Article share post ───────────────────────────────────────────────────────

  async createSharePost(userId: string, articleId: string, body: string, shareVisibility?: PostVisibility) {
    const article = await this.prisma.article.findUnique({
      where: { id: articleId },
      include: { author: { select: articleAuthorInclude } },
    }) as ArticleWithAuthor | null;

    if (!article || article.deletedAt) throw new NotFoundException('Article not found.');
    if (article.isDraft) throw new BadRequestException('Cannot share a draft article.');

    // Ensure sharer can see the article.
    await this.assertArticleAccessible(articleId, userId);

    // Enforce visibility constraint: share visibility must be >= article visibility.
    const VISIBILITY_RANK: Record<PostVisibility, number> = {
      public: 0,
      verifiedOnly: 1,
      premiumOnly: 2,
      onlyMe: 3,
    };
    const articleRank = VISIBILITY_RANK[article.visibility] ?? 0;
    const effectiveVisibility = shareVisibility ?? article.visibility;
    const shareRank = VISIBILITY_RANK[effectiveVisibility] ?? 0;
    if (shareRank < articleRank) {
      throw new BadRequestException(
        `Share visibility must be at least as restrictive as the article's visibility (${article.visibility}).`,
      );
    }

    const post = await this.prisma.post.create({
      data: {
        userId,
        body: body.trim(),
        kind: 'articleShare',
        visibility: effectiveVisibility,
        articleId,
      },
      include: {
        user: {
          select: {
            id: true, username: true, name: true, premium: true, premiumPlus: true,
            isOrganization: true, stewardBadgeEnabled: true, verifiedStatus: true,
            avatarKey: true, avatarUpdatedAt: true, bannedAt: true,
            orgMemberships: { include: { org: { select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true } } } },
          },
        },
        media: true,
        mentions: { include: { user: { select: { id: true, username: true, verifiedStatus: true, premium: true, premiumPlus: true, isOrganization: true, stewardBadgeEnabled: true } } } },
        article: { include: { author: { select: articleAuthorInclude } } },
      },
    });

    const mappedPost = toPostDto(post as any, this.r2BaseUrl);
    return { post: mappedPost, article: toArticleSharePreviewDto(article, this.r2BaseUrl) };
  }

  // ─── Internal ─────────────────────────────────────────────────────────────────

  private async assertArticleAccessible(articleId: string, viewerUserId?: string | null) {
    const article = await this.prisma.article.findUnique({
      where: { id: articleId },
      select: { id: true, isDraft: true, deletedAt: true, visibility: true, authorId: true },
    });
    if (!article || article.deletedAt) throw new NotFoundException('Article not found.');
    if (article.isDraft && article.authorId !== viewerUserId) {
      throw new NotFoundException('Article not found.');
    }
    if (!article.isDraft) {
      const viewerCtx = viewerUserId ? await this.viewer.getViewer(viewerUserId) : null;
      const allowed = this.viewer.allowedPostVisibilities(viewerCtx);
      if (!allowed.includes(article.visibility) && article.authorId !== viewerUserId) {
        throw new NotFoundException('Article not found.');
      }
    }
  }
}
