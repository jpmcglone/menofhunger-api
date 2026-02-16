import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PostVisibility, VerifiedStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { PostWithAuthorAndMedia } from '../../common/dto/post.dto';
import { toPostDto, type TopicCategoryDto, type TopicDto } from '../../common/dto';
import { AppConfigService } from '../app/app-config.service';
import { PostsService } from '../posts/posts.service';
import { TOPIC_OPTIONS } from '../../common/topics/topic-options';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';

type Viewer = { id: string; verifiedStatus: VerifiedStatus; premium: boolean } | null;

function normalizeTopic(s: string): string {
  const trimmed = (s ?? '').trim().toLowerCase();
  if (!trimmed) return '';
  // Collapse whitespace to single spaces.
  return trimmed.replace(/\s+/g, ' ').slice(0, 64);
}

function normalizeKey(s: string): string {
  return normalizeTopic(s)
    .replace(/_/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// (token extraction helpers removed; we now aggregate Post.topics directly)

const TOPIC_POST_INCLUDE = {
  user: true,
  media: { orderBy: { position: 'asc' as const } },
  mentions: { include: { user: { select: { id: true, username: true, verifiedStatus: true, premium: true, premiumPlus: true } } } },
} as const;

@Injectable()
export class TopicsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
    private readonly appConfig: AppConfigService,
  ) {}

  private topicsCache: { expiresAt: number; data: TopicDto[] } | null = null;

  private categoryLabelByKey(): Map<string, string> {
    const map = new Map<string, string>();
    for (const opt of TOPIC_OPTIONS) {
      const key = normalizeKey(opt.group);
      if (!key) continue;
      if (!map.has(key)) map.set(key, opt.group);
    }
    return map;
  }

  private categoryKeyForTopicValue(value: string): { key: string; label: string } {
    const opt = TOPIC_OPTIONS.find((o) => o.value === value);
    const label = opt?.group ?? 'Other';
    const key = normalizeKey(label) || 'other';
    return { key, label };
  }

  private topicOptionByKey(): Map<string, string> {
    const optionByKey = new Map<string, string>();
    for (const opt of TOPIC_OPTIONS) {
      optionByKey.set(normalizeKey(opt.value), opt.value);
      optionByKey.set(normalizeKey(opt.label), opt.value);
      for (const a of opt.aliases ?? []) optionByKey.set(normalizeKey(a), opt.value);
    }
    return optionByKey;
  }

  private resolveAllowlistedTopicOrThrow(topicParam: string): string {
    const raw = normalizeKey(topicParam);
    const mapped = this.topicOptionByKey().get(raw) ?? null;
    if (!mapped) throw new BadRequestException('Unknown topic.');
    return mapped;
  }

  private async viewerById(viewerUserId: string | null): Promise<Viewer> {
    if (!viewerUserId) return null;
    return await this.prisma.user.findUnique({
      where: { id: viewerUserId },
      select: { id: true, verifiedStatus: true, premium: true },
    });
  }

  private async followedTopicSet(viewerUserId: string | null): Promise<Set<string>> {
    if (!viewerUserId) return new Set<string>();
    const rows = await this.prisma.topicFollow.findMany({
      where: { userId: viewerUserId },
      select: { topic: true },
    });
    // No backwards compatibility: follows must already be canonical allowlist values.
    return new Set(rows.map((r) => r.topic));
  }

  private allowedVisibilitiesForViewer(viewer: Viewer): PostVisibility[] {
    const allowed: PostVisibility[] = ['public'];
    if (viewer?.verifiedStatus && viewer.verifiedStatus !== 'none') allowed.push('verifiedOnly');
    if (viewer?.premium) allowed.push('premiumOnly');
    return allowed;
  }

  private async combinedTopicsCached(params: { viewerUserId: string | null }): Promise<TopicDto[]> {
    const viewer = await this.viewerById(params.viewerUserId ?? null);
    const allowed = this.allowedVisibilitiesForViewer(viewer);

    const now = Date.now();
    // Topics are global-ish and expensive-ish (post scan). Cache briefly.
    if (this.topicsCache && this.topicsCache.expiresAt > now) {
      return this.topicsCache.data;
    }

    const optionByKey = this.topicOptionByKey();

    // 1) Interests (aggregated): unnest interests arrays and count.
    // Only use users who completed onboarding enough to set a username (reduces noise from abandoned signups).
    const interestRows = await this.prisma.$queryRaw<Array<{ topic: string; count: number }>>(Prisma.sql`
      SELECT
        LOWER(TRIM(i)) as "topic",
        CAST(COUNT(*) AS INT) as "count"
      FROM "User" u
      CROSS JOIN LATERAL UNNEST(u."interests") AS i
      WHERE u."usernameIsSet" = true
      GROUP BY 1
      ORDER BY "count" DESC
      LIMIT 500
    `);
    const interestCount = new Map<string, number>();
    for (const r of interestRows) {
      const normalized = normalizeKey(r.topic);
      const mapped = optionByKey.get(normalized) ?? null;
      if (!mapped) continue;
      interestCount.set(mapped, r.count ?? 0);
    }

    // 2) Post topics: aggregate from stored Post.topics (cheap + indexed).
    const lookbackDays = 14;
    const minCreatedAt = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    const allowedSql = allowed.map((v) => Prisma.sql`${v}::"PostVisibility"`);
    const postRows = await this.prisma.$queryRaw<Array<{ topic: string; count: number }>>(Prisma.sql`
      SELECT
        LOWER(TRIM(t)) as "topic",
        CAST(COUNT(*) AS INT) as "count"
      FROM "Post" p
      CROSS JOIN LATERAL UNNEST(p."topics") AS t
      WHERE
        p."deletedAt" IS NULL
        AND p."createdAt" >= ${minCreatedAt}
        AND p."parentId" IS NULL
        AND p."visibility" IN (${Prisma.join(allowedSql)})
      GROUP BY 1
      ORDER BY "count" DESC
      LIMIT 2000
    `);
    const postCount = new Map<string, number>();
    for (const r of postRows) {
      const normalized = normalizeKey(r.topic);
      const mapped = optionByKey.get(normalized) ?? null;
      if (!mapped) continue;
      postCount.set(mapped, r.count ?? 0);
    }

    // 3) Combine + rank.
    const keys = new Set<string>(TOPIC_OPTIONS.map((o) => o.value));
    const combined: TopicDto[] = [];
    for (const k of keys) {
      const interests = interestCount.get(k) ?? 0;
      const posts = postCount.get(k) ?? 0;
      // Mildly bias toward interests (strong explicit signal).
      const score = interests * 2 + posts * 1;
      const cat = this.categoryKeyForTopicValue(k);
      combined.push({
        topic: k,
        category: cat.key,
        categoryLabel: cat.label,
        score,
        interestCount: interests,
        postCount: posts,
      });
    }
    combined.sort((a, b) => b.score - a.score || b.interestCount - a.interestCount || b.postCount - a.postCount || a.topic.localeCompare(b.topic));

    // Keep a stable list; cache for 5 minutes.
    this.topicsCache = { expiresAt: now + 5 * 60 * 1000, data: combined };
    return combined;
  }

  async listTopics(params: { viewerUserId: string | null; limit: number }): Promise<TopicDto[]> {
    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const combined = await this.combinedTopicsCached({ viewerUserId: params.viewerUserId ?? null });
    const followed = await this.followedTopicSet(params.viewerUserId ?? null);
    return combined.slice(0, limit).map((t) => (followed.size > 0 ? { ...t, viewerFollows: followed.has(t.topic) } : t));
  }

  async listCategories(params: { viewerUserId: string | null; limit: number }): Promise<TopicCategoryDto[]> {
    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const combined = await this.combinedTopicsCached({ viewerUserId: params.viewerUserId ?? null });
    const labelByKey = this.categoryLabelByKey();

    const agg = new Map<string, TopicCategoryDto>();
    for (const t of combined) {
      const key = t.category;
      const label = labelByKey.get(key) ?? t.categoryLabel ?? key;
      const existing = agg.get(key);
      if (!existing) {
        agg.set(key, {
          category: key,
          label,
          score: t.score ?? 0,
          interestCount: t.interestCount ?? 0,
          postCount: t.postCount ?? 0,
        });
      } else {
        existing.score += t.score ?? 0;
        existing.interestCount += t.interestCount ?? 0;
        existing.postCount += t.postCount ?? 0;
      }
    }

    const rows = Array.from(agg.values());
    rows.sort((a, b) => b.score - a.score || b.postCount - a.postCount || b.interestCount - a.interestCount || a.label.localeCompare(b.label));
    return rows.slice(0, limit);
  }

  private resolveCategoryKeyOrThrow(categoryParam: string): { key: string; label: string } {
    const key = normalizeKey(categoryParam);
    const labelByKey = this.categoryLabelByKey();
    const label = labelByKey.get(key) ?? null;
    if (!key || !label) throw new BadRequestException('Unknown category.');
    return { key, label };
  }

  async listCategoryTopics(params: { viewerUserId: string | null; category: string }): Promise<TopicDto[]> {
    const resolved = this.resolveCategoryKeyOrThrow(params.category);
    const combined = await this.combinedTopicsCached({ viewerUserId: params.viewerUserId ?? null });
    const followed = await this.followedTopicSet(params.viewerUserId ?? null);
    const rows = combined
      .filter((t) => t.category === resolved.key)
      .map((t) => (followed.size > 0 ? { ...t, viewerFollows: followed.has(t.topic) } : t));
    // Keep stable order from TOPIC_OPTIONS (combinedTopicsCached already preserves topic-order before ranking? It sorts for global.)
    // For category topic lists, prefer postCount then interestCount for relevance.
    rows.sort((a, b) => (b.postCount ?? 0) - (a.postCount ?? 0) || (b.interestCount ?? 0) - (a.interestCount ?? 0) || a.topic.localeCompare(b.topic));
    return rows;
  }

  async listCategoryPosts(params: { viewerUserId: string | null; category: string; limit: number; cursor: string | null }) {
    const resolved = this.resolveCategoryKeyOrThrow(params.category);

    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const cursor = (params.cursor ?? '').trim() || null;

    const combined = await this.combinedTopicsCached({ viewerUserId: params.viewerUserId ?? null });
    const topicValues = combined.filter((t) => t.category === resolved.key).map((t) => t.topic);
    if (topicValues.length === 0) return { posts: [], nextCursor: null };

    const viewer = await this.viewerById(params.viewerUserId ?? null);
    const allowed = this.allowedVisibilitiesForViewer(viewer);
    const visibilityWhere: Prisma.PostWhereInput = viewer?.id
      ? {
          OR: [{ visibility: { in: allowed } }, { userId: viewer.id, visibility: 'onlyMe' }],
        }
      : { visibility: 'public' };

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const rows = await this.prisma.post.findMany({
      where: {
        AND: [
          { deletedAt: null },
          { parentId: null },
          visibilityWhere,
          { topics: { hasSome: topicValues } },
          ...(cursorWhere ? [cursorWhere as Prisma.PostWhereInput] : []),
        ],
      },
      include: TOPIC_POST_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? (slice[slice.length - 1]?.id ?? null) : null;

    const postIds = slice.map((p) => p.id);
    const boosted = params.viewerUserId ? await this.posts.viewerBoostedPostIds({ viewerUserId: params.viewerUserId, postIds }) : new Set<string>();
    const bookmarksByPostId = params.viewerUserId
      ? await this.posts.viewerBookmarksByPostId({ viewerUserId: params.viewerUserId, postIds })
      : new Map<string, { collectionIds: string[] }>();

    const viewerCtx = await this.posts.viewerContext(params.viewerUserId ?? null);
    const viewerHasAdmin = Boolean(viewerCtx?.siteAdmin);
    const internalByPostId = viewerHasAdmin && postIds.length > 0 ? await this.posts.ensureBoostScoresFresh(postIds) : null;
    const scoreByPostId = viewerHasAdmin && postIds.length > 0 ? await this.posts.computeScoresForPostIds(postIds) : undefined;

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const posts = slice.map((p) => {
      const base = internalByPostId?.get(p.id);
      const score = scoreByPostId?.get(p.id);
      return toPostDto(p as PostWithAuthorAndMedia, publicBaseUrl, {
        viewerHasBoosted: boosted.has(p.id),
        viewerHasBookmarked: bookmarksByPostId.has(p.id),
        viewerBookmarkCollectionIds: bookmarksByPostId.get(p.id)?.collectionIds ?? [],
        includeInternal: viewerHasAdmin,
        internalOverride:
          base || (typeof score === 'number' ? { score } : undefined)
            ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
            : undefined,
      });
    });

    return { posts, nextCursor };
  }

  async listFollowedTopics(params: { viewerUserId: string; limit: number }): Promise<TopicDto[]> {
    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const followed = await this.followedTopicSet(params.viewerUserId);
    if (followed.size === 0) return [];
    const combined = await this.combinedTopicsCached({ viewerUserId: params.viewerUserId });
    const rows = combined.filter((t) => followed.has(t.topic)).map((t) => ({ ...t, viewerFollows: true }));
    return rows.slice(0, limit);
  }

  async followTopic(params: { userId: string; topic: string }) {
    const topic = this.resolveAllowlistedTopicOrThrow(params.topic);
    await this.prisma.topicFollow.upsert({
      where: { userId_topic: { userId: params.userId, topic } },
      create: { userId: params.userId, topic },
      update: {},
    });
    return { topic };
  }

  async unfollowTopic(params: { userId: string; topic: string }) {
    const topic = this.resolveAllowlistedTopicOrThrow(params.topic);
    await this.prisma.topicFollow.deleteMany({ where: { userId: params.userId, topic } });
    return { topic };
  }

  async listTopicPosts(params: { viewerUserId: string | null; topic: string; limit: number; cursor: string | null }) {
    const q = this.resolveAllowlistedTopicOrThrow(params.topic);

    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const cursor = (params.cursor ?? '').trim() || null;

    const viewer = await this.viewerById(params.viewerUserId ?? null);
    const allowed = this.allowedVisibilitiesForViewer(viewer);
    const visibilityWhere: Prisma.PostWhereInput = viewer?.id
      ? {
          OR: [{ visibility: { in: allowed } }, { userId: viewer.id, visibility: 'onlyMe' }],
        }
      : { visibility: 'public' };

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const rows = await this.prisma.post.findMany({
      where: {
        AND: [
          { deletedAt: null },
          { parentId: null },
          visibilityWhere,
          { topics: { has: q } },
          ...(cursorWhere ? [cursorWhere as Prisma.PostWhereInput] : []),
        ],
      },
      include: TOPIC_POST_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? (slice[slice.length - 1]?.id ?? null) : null;

    const postIds = slice.map((p) => p.id);
    const boosted = params.viewerUserId ? await this.posts.viewerBoostedPostIds({ viewerUserId: params.viewerUserId, postIds }) : new Set<string>();
    const bookmarksByPostId = params.viewerUserId
      ? await this.posts.viewerBookmarksByPostId({ viewerUserId: params.viewerUserId, postIds })
      : new Map<string, { collectionIds: string[] }>();

    const viewerCtx = await this.posts.viewerContext(params.viewerUserId ?? null);
    const viewerHasAdmin = Boolean(viewerCtx?.siteAdmin);
    const internalByPostId = viewerHasAdmin && postIds.length > 0 ? await this.posts.ensureBoostScoresFresh(postIds) : null;
    const scoreByPostId = viewerHasAdmin && postIds.length > 0 ? await this.posts.computeScoresForPostIds(postIds) : undefined;

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const posts = slice.map((p) => {
      const base = internalByPostId?.get(p.id);
      const score = scoreByPostId?.get(p.id);
      return toPostDto(p as PostWithAuthorAndMedia, publicBaseUrl, {
        viewerHasBoosted: boosted.has(p.id),
        viewerHasBookmarked: bookmarksByPostId.has(p.id),
        viewerBookmarkCollectionIds: bookmarksByPostId.get(p.id)?.collectionIds ?? [],
        includeInternal: viewerHasAdmin,
        internalOverride:
          base || (typeof score === 'number' ? { score } : undefined)
            ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
            : undefined,
      });
    });

    return { posts, nextCursor };
  }
}

