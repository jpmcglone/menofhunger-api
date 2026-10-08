import { BadRequestException, ForbiddenException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { PostVisibility } from '@prisma/client';
import { JOBS } from '../jobs/jobs.constants';
import { easternDayKey } from '../../common/time/eastern-day-key';
import { parseMentionsFromBody } from '../../common/mentions/mention-regex';
import { assertPublishableText } from '../../common/moderation/content-filter';
import { LOGGED_IN_VIEW_WEIGHT } from '../views/view-tracking.utils';
import { toArticleCommentDto, toArticleDto, type ArticleCommentWithAuthorAndReactions, type ArticleWithAuthor } from '../../common/dto/article.dto';
import type { ArticlesService } from './articles.service';
import { toPage } from '../../common/pagination/page';
import { normalizeCommentBody, normalizeTag } from '../../common/text/normalize';
import { assertOwnerOrAdmin } from '../../common/access/assert-owner-or-admin';

const VERIFIED_ARTICLES_PER_DAY = 1;

export async function listPublishedRawOn(host: ArticlesService, 
  opts: {
    viewerUserId?: string | null;
    limit?: number;
    cursor?: string | null;
    authorUsername?: string | null;
    sort?: 'new' | 'trending' | null;
    visibilityFilter?: PostVisibility | null;
    mine?: boolean | null;
    followingOnly?: boolean | null;
    tag?: string | null;
    includeRestricted?: boolean | null;
    includeBody?: boolean | null;
  },
  limit: number,
  sort: string,
) {
  const viewerCtx = opts.viewerUserId ? await host.viewer.getViewer(opts.viewerUserId) : null;
  const allowedVisibilities = host.viewer.allowedPostVisibilities(viewerCtx);

  // followingOnly / mine with no authenticated viewer returns nothing
  if ((opts.followingOnly || opts.mine) && !opts.viewerUserId) {
    return { articles: [], nextCursor: null };
  }

  if (!opts.includeRestricted && opts.visibilityFilter && !allowedVisibilities.includes(opts.visibilityFilter)) {
    if (opts.visibilityFilter === 'verifiedOnly') {
      throw new ForbiddenException('Verify to view verified-only posts.');
    }
    if (opts.visibilityFilter === 'premiumOnly') {
      throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
    }
  }

  const effectiveVisibilities = opts.visibilityFilter ? [opts.visibilityFilter] : allowedVisibilities;

  const normalizedAuthorUsername = (opts.authorUsername ?? '').trim();

  const authorFilter = opts.mine
    ? { authorId: opts.viewerUserId! }
    : normalizedAuthorUsername
      ? { author: { username: { equals: normalizedAuthorUsername, mode: 'insensitive' as const } } }
      : opts.followingOnly && opts.viewerUserId
        ? { author: { followers: { some: { followerId: opts.viewerUserId } } } }
        : {};

  const tagFilter = opts.tag
    ? { tags: { some: { tag: normalizeTag(opts.tag) } } }
    : {};

  // When includeRestricted is set we normally skip the visibility WHERE so all tiers appear.
  // However, if the caller also provides an explicit visibilityFilter (e.g. the user picked
  // "public only"), honour that filter even in restricted-include mode.
  const visibilityFilter = opts.includeRestricted
    ? opts.visibilityFilter
      ? { visibility: opts.visibilityFilter }
      : {}
    : { visibility: { in: effectiveVisibilities } };

  const toDto = (a: ArticleWithAuthor, viewed: Set<string>) => {
    const viewerCanAccess =
      allowedVisibilities.includes(a.visibility) || a.authorId === opts.viewerUserId;
    return toArticleDto(a, host.r2BaseUrl, {
      viewerUserId: opts.viewerUserId,
      viewerHasBoosted: opts.viewerUserId ? (a.boosts?.length ?? 0) > 0 : false,
      viewerHasViewed: opts.viewerUserId ? viewed.has(a.id) : undefined,
      viewerCanAccess,
      includeBody: opts.includeBody ?? false,
    });
  };

  const mapItems = async (items: ArticleWithAuthor[]) => {
    const viewed = await host.articleViews.viewerViewedArticleIds(
      opts.viewerUserId,
      items.map((a) => a.id),
    );
    return items.map((a) => toDto(a, viewed));
  };

  if (sort === 'trending') {
    // Offset-based for trending (score changes, cursor-based is unreliable).
    // Include all articles regardless of trendingScore; nulls sort last explicitly (Postgres defaults to NULLS FIRST with DESC).
    const skip = opts.cursor ? parseInt(opts.cursor, 10) : 0;
    const articles = await host.prisma.article.findMany({
      where: {
        isDraft: false,
        deletedAt: null,
        publishedAt: { not: null },
        ...visibilityFilter,
        ...authorFilter,
        ...tagFilter,
      },
      orderBy: [{ trendingScore: { sort: 'desc', nulls: 'last' } }, { publishedAt: 'desc' }],
      skip,
      take: limit + 1,
      include: host.articleIncludes(true, true, opts.viewerUserId),
    }) as ArticleWithAuthor[];

    const hasMore = articles.length > limit;
    const items = hasMore ? articles.slice(0, limit) : articles;
    const nextCursor = hasMore ? String(skip + limit) : null;

    return { articles: await mapItems(items), nextCursor };
  }

  // Default: newest first, cursor-based
  const articles = await host.prisma.article.findMany({
    where: {
      isDraft: false,
      deletedAt: null,
      publishedAt: { not: null },
      ...visibilityFilter,
      ...authorFilter,
      ...tagFilter,
      ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
    },
    orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: host.articleIncludes(true, true, opts.viewerUserId),
  }) as ArticleWithAuthor[];

  const { items: items, nextCursor: nextCursor } = toPage(articles, limit, (r) => r.id);

  return { articles: await mapItems(items), nextCursor };
}


export async function publishArticleOn(host: ArticlesService, userId: string, articleId: string, opts: { postToBoard?: boolean; shareToFeed?: boolean; crosspost?: { pickax?: 'link' | 'native'; x?: 'link' | 'native' } } = {}) {
  const article = await host.prisma.article.findUnique({ where: { id: articleId } });
  if (!article || article.deletedAt) throw new NotFoundException('Article not found.');
  assertOwnerOrAdmin({ userId }, article.authorId, 'Not your article.');
  if (!article.title.trim()) throw new BadRequestException('Article must have a title before publishing.');

  const viewerCtx = await host.viewer.getViewerOrThrow(userId);
  if (!host.viewer.isVerified(viewerCtx) && !host.viewer.isPremium(viewerCtx)) {
    throw new ForbiddenException('Verify your account to publish articles.');
  }

  const allowedVisibilities = host.viewer.allowedPostVisibilities(viewerCtx);
  if (!allowedVisibilities.includes(article.visibility)) {
    throw new ForbiddenException("This article's visibility is not available on your current plan.");
  }

  const isFirstPublish = !article.publishedAt;

  // Verified non-premium: 1 first-publish per Eastern calendar day
  if (isFirstPublish && !host.viewer.isPremium(viewerCtx)) {
    const todayKey = easternDayKey(new Date());
    // 36h lookback covers any ET offset; filter in memory by day key
    const windowStart = new Date(Date.now() - 36 * 60 * 60 * 1000);
    const recentPublished = await host.prisma.article.findMany({
      where: { authorId: userId, publishedAt: { gte: windowStart }, deletedAt: null, id: { not: articleId } },
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

  const updated = await host.prisma.$transaction(async (tx) => {
    const published = await tx.article.update({
      where: { id: articleId },
      data: {
        isDraft: false,
        crosspostChoices: opts.crosspost,
        publishedAt: article.publishedAt ?? new Date(),
        editedAt: article.publishedAt ? new Date() : null,
        lastSavedAt: new Date(),
      },
      include: host.articleIncludes(true, true, userId),
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
        (published as any).viewCount = updatedCounts.viewCount;
        (published as any).totalViewCount = updatedCounts.totalViewCount;
        (published as any).weightedViewCount = updatedCounts.weightedViewCount;
      }
    }
    return published;
  });

  if (isFirstPublish) {
    await host.crossPostToBoard(userId, updated, opts);
  }

  // Fire follower notifications only on first publish. The fan-out scales with the author's
  // follower count, so it runs on the side-effects queue rather than in this process.
  if (isFirstPublish) {
    host.sideEffects.dispatch(
      'article.published',
      { articleId, authorUserId: userId },
      { jobId: `article-published-${articleId}` },
    );
  }

  void host.cacheInvalidation.bumpFeedGlobal().catch(() => undefined);

  // Notify the WebSub hub so subscribers get real-time feed updates.
  void host.pingWebsubHub(updated.author?.username ?? null).catch(() => undefined);

  // Enqueue follower article emails on first publish.
  if (isFirstPublish) {
    host.jobs
      .enqueue(JOBS.articlesFollowedArticleEmail, { articleId, authorUserId: userId })
      .catch((err) => {
        host.logger.warn(
          `[email] Failed to enqueue followed-article email job: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  return toArticleDto(updated, host.r2BaseUrl, { viewerUserId: userId });
}

export async function createArticleCommentOn(host: ArticlesService, 
  userId: string,
  articleId: string,
  data: { body: string; parentId?: string | null },
) {
  const viewerCtx = await host.viewer.getViewerOrThrow(userId);
  if (!host.viewer.isVerified(viewerCtx) && !host.viewer.isPremium(viewerCtx)) {
    throw new ForbiddenException('Verified membership required to comment.');
  }

  const normalizedBody = normalizeCommentBody(data.body);
  assertPublishableText(normalizedBody);
  const maxCommentLength = host.viewer.isPremium(viewerCtx) ? 1000 : 500;
  if (normalizedBody.length > maxCommentLength) {
    throw new BadRequestException(`Comment must be ${maxCommentLength} characters or fewer.`);
  }

  await host.assertArticleAccessible(articleId, userId);

  if (data.parentId) {
    const parent = await host.prisma.articleComment.findUnique({ where: { id: data.parentId } });
    if (!parent || parent.deletedAt) throw new NotFoundException('Parent comment not found.');
    if (parent.articleId !== articleId) throw new BadRequestException('Parent comment belongs to a different article.');
    if (parent.parentId !== null) throw new BadRequestException('Cannot reply more than one level deep.');
  }

  let newCommentCount: number | null = null;
  const comment = await host.prisma.$transaction(async (tx) => {
    const c = await tx.articleComment.create({
      data: {
        articleId,
        authorId: userId,
        body: normalizedBody,
        parentId: data.parentId ?? null,
      },
      include: host.commentIncludes(),
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

  const commentDto = toArticleCommentDto(comment, host.r2BaseUrl, { viewerUserId: userId });

  if (newCommentCount !== null) {
    host.presenceRealtime.emitArticlesLiveUpdated(articleId, {
      articleId,
      version: new Date().toISOString(),
      reason: 'commentCount',
      patch: { commentCount: newCommentCount },
    });
  }

  host.presenceRealtime.emitArticlesCommentAdded(articleId, { articleId, comment: commentDto });
  if (newCommentCount !== null) {
    void host.board.syncArticleThread(articleId, { commentCount: newCommentCount }).catch(() => undefined);
  }

  host.sideEffects.dispatch('article.comment.created', {
    articleId,
    commentId: comment.id,
    actorUserId: userId,
    parentCommentId: data.parentId ?? null,
    mentionUsernames: parseMentionsFromBody(commentDto.body ?? ''),
  });

  return commentDto;
}
