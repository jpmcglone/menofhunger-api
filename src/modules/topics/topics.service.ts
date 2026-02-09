import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PostVisibility, VerifiedStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { PostWithAuthorAndMedia } from '../../common/dto/post.dto';
import { toPostDto, type TopicDto } from '../../common/dto';
import { AppConfigService } from '../app/app-config.service';
import { PostsService } from '../posts/posts.service';
import { SearchService } from '../search/search.service';
import { TOPIC_OPTIONS } from '../../common/topics/topic-options';

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

@Injectable()
export class TopicsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    private readonly posts: PostsService,
    private readonly appConfig: AppConfigService,
  ) {}

  private topicsCache: { expiresAt: number; data: TopicDto[] } | null = null;

  private async viewerById(viewerUserId: string | null): Promise<Viewer> {
    if (!viewerUserId) return null;
    return await this.prisma.user.findUnique({
      where: { id: viewerUserId },
      select: { id: true, verifiedStatus: true, premium: true },
    });
  }

  private allowedVisibilitiesForViewer(viewer: Viewer): PostVisibility[] {
    const allowed: PostVisibility[] = ['public'];
    if (viewer?.verifiedStatus && viewer.verifiedStatus !== 'none') allowed.push('verifiedOnly');
    if (viewer?.premium) allowed.push('premiumOnly');
    return allowed;
  }

  async listTopics(params: { viewerUserId: string | null; limit: number }): Promise<TopicDto[]> {
    const limit = Math.max(1, Math.min(50, params.limit || 30));

    const viewer = await this.viewerById(params.viewerUserId ?? null);
    const allowed = this.allowedVisibilitiesForViewer(viewer);

    const now = Date.now();
    // Topics are global-ish and expensive-ish (post scan). Cache briefly.
    if (this.topicsCache && this.topicsCache.expiresAt > now) {
      return this.topicsCache.data.slice(0, limit);
    }

    const optionByKey = new Map<string, string>();
    for (const opt of TOPIC_OPTIONS) {
      optionByKey.set(normalizeKey(opt.value), opt.value);
      optionByKey.set(normalizeKey(opt.label), opt.value);
      for (const a of opt.aliases ?? []) optionByKey.set(normalizeKey(a), opt.value);
    }

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
      combined.push({ topic: k, score, interestCount: interests, postCount: posts });
    }
    combined.sort((a, b) => b.score - a.score || b.interestCount - a.interestCount || b.postCount - a.postCount || a.topic.localeCompare(b.topic));

    // Keep a stable list; cache for 5 minutes.
    this.topicsCache = { expiresAt: now + 5 * 60 * 1000, data: combined };

    return combined.slice(0, limit);
  }

  async listTopicPosts(params: { viewerUserId: string | null; topic: string; limit: number; cursor: string | null }) {
    const qRaw = normalizeKey(params.topic);
    const optionByKey = new Map<string, string>();
    for (const opt of TOPIC_OPTIONS) {
      optionByKey.set(normalizeKey(opt.value), opt.value);
      optionByKey.set(normalizeKey(opt.label), opt.value);
      for (const a of opt.aliases ?? []) optionByKey.set(normalizeKey(a), opt.value);
    }
    const mapped = optionByKey.get(qRaw) ?? null;
    const q = mapped ?? normalizeTopic(params.topic);
    if (!q) return { posts: [], nextCursor: null };

    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const cursor = (params.cursor ?? '').trim() || null;

    const res = await this.search.searchPosts({
      viewerUserId: params.viewerUserId ?? null,
      q,
      limit,
      cursor,
    });

    const postIds = (res.posts ?? []).map((p) => p.id);
    const boosted = params.viewerUserId ? await this.posts.viewerBoostedPostIds({ viewerUserId: params.viewerUserId, postIds }) : new Set<string>();
    const bookmarksByPostId = params.viewerUserId
      ? await this.posts.viewerBookmarksByPostId({ viewerUserId: params.viewerUserId, postIds })
      : new Map<string, { collectionIds: string[] }>();

    const viewer = await this.posts.viewerContext(params.viewerUserId ?? null);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);
    const internalByPostId = viewerHasAdmin && postIds.length > 0 ? await this.posts.ensureBoostScoresFresh(postIds) : null;
    const scoreByPostId = viewerHasAdmin && postIds.length > 0 ? await this.posts.computeScoresForPostIds(postIds) : undefined;

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const posts = (res.posts ?? []).map((p) => {
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

    return { posts, nextCursor: res.nextCursor ?? null };
  }
}

