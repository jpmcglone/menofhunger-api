import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PostVisibility, VerifiedStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';

export type PostCounts = {
  all: number;
  public: number;
  verifiedOnly: number;
  premiumOnly: number;
};

@Injectable()
export class PostsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Centralized guardrail: any query that *returns posts* should include this.
   * This prevents accidentally surfacing soft-deleted posts via new endpoints.
   */
  private notDeletedWhere(): Prisma.PostWhereInput {
    return { deletedAt: null };
  }

  private static boostScoreTtlMs = 10 * 60 * 1000;
  private static popularHalfLifeSeconds = 24 * 60 * 60;
  private static popularLookbackDays = 30;
  private static popularWarmupTake = 200;

  private encodePopularCursor(cursor: { asOf: string; score: number; createdAt: string; id: string }) {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodePopularCursor(token: string | null): { asOf: string; score: number; createdAt: string; id: string } | null {
    const t = (token ?? '').trim();
    if (!t) return null;
    try {
      const raw = Buffer.from(t, 'base64url').toString('utf8');
      const parsed = JSON.parse(raw) as Partial<{ asOf: string; score: number; createdAt: string; id: string }>;
      const asOf = typeof parsed.asOf === 'string' ? parsed.asOf : '';
      const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : '';
      const id = typeof parsed.id === 'string' ? parsed.id : '';
      const score = typeof parsed.score === 'number' && Number.isFinite(parsed.score) ? parsed.score : NaN;
      if (!asOf || !createdAt || !id) return null;
      if (!Number.isFinite(score)) return null;
      return { asOf, score, createdAt, id };
    } catch {
      return null;
    }
  }

  async ensureBoostScoresFresh(postIds: string[]) {
    const ids = (postIds ?? []).filter(Boolean);
    if (ids.length === 0) return new Map<string, { boostScore: number | null; boostScoreUpdatedAt: Date | null }>();

    const now = new Date();
    const staleBefore = new Date(now.getTime() - PostsService.boostScoreTtlMs);

    const posts = await this.prisma.post.findMany({
      where: { id: { in: ids } },
      select: { id: true, boostScoreUpdatedAt: true },
    });

    const staleIds = posts
      .filter((p) => !p.boostScoreUpdatedAt || p.boostScoreUpdatedAt < staleBefore)
      .map((p) => p.id);

    if (staleIds.length > 0) {
      const rows = await this.prisma.$queryRaw<Array<{ postId: string; score: number | null }>>(Prisma.sql`
        SELECT
          b."postId" as "postId",
          CAST(
            SUM(
              (
                CASE
                  WHEN u."premium" THEN 3
                  WHEN u."verifiedStatus" <> 'none' THEN 2
                  ELSE 1
                END
              )
              * POWER(
                0.5,
                EXTRACT(EPOCH FROM (NOW() - b."createdAt")) / (24 * 60 * 60)
              )
            ) AS DOUBLE PRECISION
          ) as "score"
        FROM "Boost" b
        JOIN "User" u ON u."id" = b."userId"
        WHERE b."postId" IN (${Prisma.join(staleIds)})
        GROUP BY b."postId"
      `);

      const scoreByPostId = new Map<string, number>();
      for (const r of rows) scoreByPostId.set(r.postId, r.score ?? 0);

      const tuples = staleIds.map((id) => Prisma.sql`(${id}, ${scoreByPostId.get(id) ?? 0})`);
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "Post" AS p
        SET
          "boostScore" = v.score,
          "boostScoreUpdatedAt" = ${now}
        FROM (VALUES ${Prisma.join(tuples)}) AS v(id, score)
        WHERE p."id" = v.id
      `);
    }

    const refreshed = await this.prisma.post.findMany({
      where: { id: { in: ids } },
      select: { id: true, boostScore: true, boostScoreUpdatedAt: true },
    });

    const out = new Map<string, { boostScore: number | null; boostScoreUpdatedAt: Date | null }>();
    for (const p of refreshed) out.set(p.id, { boostScore: p.boostScore ?? null, boostScoreUpdatedAt: p.boostScoreUpdatedAt });
    return out;
  }

  private async getSiteConfig() {
    const cfg = await this.prisma.siteConfig.findUnique({ where: { id: 1 } });
    // If missing (shouldn't happen after migrations), use safe defaults.
    return cfg ?? { id: 1, postsPerWindow: 5, windowSeconds: 300 };
  }

  private async viewerById(viewerUserId: string | null) {
    if (!viewerUserId) return null;
    return await this.prisma.user.findUnique({
      where: { id: viewerUserId },
      select: { id: true, verifiedStatus: true, premium: true, siteAdmin: true },
    });
  }

  async viewerContext(viewerUserId: string | null) {
    return await this.viewerById(viewerUserId);
  }

  async viewerBoostedPostIds(params: { viewerUserId: string; postIds: string[] }) {
    const { viewerUserId, postIds } = params;
    if (!viewerUserId) return new Set<string>();
    const ids = (postIds ?? []).filter(Boolean);
    if (ids.length === 0) return new Set<string>();

    const boosts = await this.prisma.boost.findMany({
      where: { userId: viewerUserId, postId: { in: ids } },
      select: { postId: true },
    });
    return new Set(boosts.map((b) => b.postId));
  }

  private allowedVisibilitiesForViewer(
    viewer: { verifiedStatus: VerifiedStatus; premium: boolean; siteAdmin?: boolean } | null,
  ) {
    const allowed: PostVisibility[] = ['public'];
    if (viewer?.verifiedStatus && viewer.verifiedStatus !== 'none') allowed.push('verifiedOnly');
    if (viewer?.premium) allowed.push('premiumOnly');
    return allowed;
  }

  async listOnlyMe(params: { userId: string; limit: number; cursor: string | null }) {
    const { userId, limit, cursor } = params;

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const posts = await this.prisma.post.findMany({
      where: {
        AND: [{ userId, visibility: 'onlyMe', ...this.notDeletedWhere() }, ...(cursorWhere ? [cursorWhere] : [])],
      },
      include: { user: true, media: { orderBy: { position: 'asc' } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = posts.slice(0, limit);
    const nextCursor = posts.length > limit ? slice[slice.length - 1]?.id ?? null : null;
    return { posts: slice, nextCursor };
  }

  async listFeed(params: {
    viewerUserId: string | null;
    limit: number;
    cursor: string | null;
    visibility: 'all' | PostVisibility;
    followingOnly: boolean;
  }) {
    const { viewerUserId, limit, cursor, visibility, followingOnly } = params;

    const viewer = await this.viewerById(viewerUserId);

    const allowed = this.allowedVisibilitiesForViewer(viewer);

    if (visibility === 'verifiedOnly') {
      if (!viewer || viewer.verifiedStatus === 'none') throw new ForbiddenException('Verify to view verified-only posts.');
    }
    if (visibility === 'premiumOnly') {
      if (!viewer || !viewer.premium) throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
    }

    if (followingOnly && !viewerUserId) {
      return { posts: [], nextCursor: null };
    }

    const visibilityWhere =
      visibility === 'all'
        ? ({ visibility: { in: allowed } } as Prisma.PostWhereInput)
        : visibility === 'public'
          ? ({ visibility: 'public' } as Prisma.PostWhereInput)
          : ({ visibility } as Prisma.PostWhereInput);

    const where = followingOnly
      ? {
          AND: [
            visibilityWhere,
            this.notDeletedWhere(),
            {
              OR: [
                // Include the viewer's own posts.
                { userId: viewerUserId as string },
                // Include posts from users the viewer follows.
                { user: { followers: { some: { followerId: viewerUserId as string } } } },
              ],
            },
          ],
        }
      : { AND: [visibilityWhere, this.notDeletedWhere()] };

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });
    const whereWithCursor = cursorWhere ? ({ AND: [where, cursorWhere] } as Prisma.PostWhereInput) : where;

    const posts = await this.prisma.post.findMany({
      where: whereWithCursor,
      include: { user: true, media: { orderBy: { position: 'asc' } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = posts.slice(0, limit);
    const nextCursor = posts.length > limit ? slice[slice.length - 1]?.id ?? null : null;

    return { posts: slice, nextCursor };
  }

  async listPopularFeed(params: { viewerUserId: string | null; limit: number; cursor: string | null; visibility: 'all' | PostVisibility }) {
    const { viewerUserId, limit, cursor, visibility } = params;

    const viewer = await this.viewerById(viewerUserId);
    const allowed = this.allowedVisibilitiesForViewer(viewer);

    if (visibility === 'verifiedOnly') {
      if (!viewer || viewer.verifiedStatus === 'none') throw new ForbiddenException('Verify to view verified-only posts.');
    }
    if (visibility === 'premiumOnly') {
      if (!viewer || !viewer.premium) throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
    }

    const visibilityWhere =
      visibility === 'all'
        ? ({ visibility: { in: allowed } } as Prisma.PostWhereInput)
        : visibility === 'public'
          ? ({ visibility: 'public' } as Prisma.PostWhereInput)
          : ({ visibility } as Prisma.PostWhereInput);

    const visibilitiesForQuery: PostVisibility[] =
      visibility === 'all' ? allowed : visibility === 'public' ? (['public'] as PostVisibility[]) : ([visibility] as PostVisibility[]);
    const visibilitiesForQuerySql = visibilitiesForQuery.map((v) => Prisma.sql`${v}::"PostVisibility"`);

    const decoded = this.decodePopularCursor(cursor);

    // Stable pagination: keep a consistent "as-of" timestamp across pages.
    // First page: we warm up scores for likely-top posts, then snapshot `asOf`.
    const asOf = decoded ? new Date(decoded.asOf) : new Date();
    const asOfMs = asOf.getTime();
    const lookbackMs = PostsService.popularLookbackDays * 24 * 60 * 60 * 1000;
    const minCreatedAt = new Date(asOfMs - lookbackMs);

    if (!decoded) {
      const staleBefore = new Date(asOfMs - PostsService.boostScoreTtlMs);
      const warmup = await this.prisma.post.findMany({
        where: {
          AND: [
            visibilityWhere,
            this.notDeletedWhere(),
            { createdAt: { gte: minCreatedAt } },
            { boostCount: { gt: 0 } },
            { OR: [{ boostScoreUpdatedAt: null }, { boostScoreUpdatedAt: { lt: staleBefore } }] },
          ],
        },
        orderBy: [{ boostCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: PostsService.popularWarmupTake,
        select: { id: true },
      });

      await this.ensureBoostScoresFresh(warmup.map((p) => p.id));
    }

    // Snapshot `asOf` *after* any warmup updates, so we never "amplify" scores.
    const snapshotAsOf = decoded ? asOf : new Date();
    const snapshotMinCreatedAt = new Date(snapshotAsOf.getTime() - lookbackMs);

    const cursorCreatedAt = decoded ? new Date(decoded.createdAt) : null;
    const cursorScore = decoded?.score ?? null;
    const cursorId = decoded?.id ?? null;

    const rows = await this.prisma.$queryRaw<Array<{ id: string; createdAt: Date; score: number }>>(Prisma.sql`
      WITH scored AS (
        SELECT
          p."id" as "id",
          p."createdAt" as "createdAt",
          CAST(
            CASE
              WHEN p."boostScore" IS NULL OR p."boostScoreUpdatedAt" IS NULL THEN 0
              ELSE p."boostScore" * POWER(
                0.5,
                GREATEST(
                  0,
                  EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."boostScoreUpdatedAt"))
                ) / ${PostsService.popularHalfLifeSeconds}
              )
            END
            AS DOUBLE PRECISION
          ) as "score"
        FROM "Post" p
        WHERE
          p."deletedAt" IS NULL
          AND p."createdAt" >= ${snapshotMinCreatedAt}
          AND p."visibility" IN (${Prisma.join(visibilitiesForQuerySql)})
      )
      SELECT "id", "createdAt", "score"
      FROM scored
      WHERE
        ${
          decoded && cursorCreatedAt && cursorScore != null && cursorId
            ? Prisma.sql`
              (
                "score" < ${cursorScore}
                OR (
                  "score" = ${cursorScore}
                  AND (
                    "createdAt" < ${cursorCreatedAt}
                    OR ("createdAt" = ${cursorCreatedAt} AND "id" < ${cursorId})
                  )
                )
              )
            `
            : Prisma.sql`TRUE`
        }
      ORDER BY "score" DESC, "createdAt" DESC, "id" DESC
      LIMIT ${limit + 1}
    `);

    const sliceRows = rows.slice(0, limit);
    const ids = sliceRows.map((r) => r.id);
    const nextRow = rows.length > limit ? sliceRows[sliceRows.length - 1] ?? null : null;

    const posts = ids.length
      ? await this.prisma.post.findMany({
          where: { id: { in: ids } },
          include: { user: true, media: { orderBy: { position: 'asc' } } },
        })
      : [];
    const byId = new Map(posts.map((p) => [p.id, p] as const));
    const ordered = ids.map((id) => byId.get(id)).filter((p): p is (typeof posts)[number] => Boolean(p));

    const nextCursor =
      rows.length > limit && nextRow
        ? this.encodePopularCursor({
            asOf: snapshotAsOf.toISOString(),
            score: nextRow.score,
            createdAt: nextRow.createdAt.toISOString(),
            id: nextRow.id,
          })
        : null;

    return { posts: ordered, nextCursor };
  }

  async listForUsername(params: {
    viewerUserId: string | null;
    username: string;
    limit: number;
    cursor: string | null;
    visibility: 'all' | PostVisibility;
    includeCounts: boolean;
  }) {
    const { viewerUserId, username, limit, cursor, visibility, includeCounts } = params;
    const normalized = (username ?? '').trim();
    if (!normalized) throw new NotFoundException('User not found.');

    const user = await this.prisma.user.findFirst({
      where: { username: { equals: normalized, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found.');

    const viewer = await this.viewerById(viewerUserId);

    const isSelf = Boolean(viewer && viewer.id === user.id);

    const counts: PostCounts | null = includeCounts
      ? await (async () => {
          const grouped = await this.prisma.post.groupBy({
            by: ['visibility'],
            where: { userId: user.id, visibility: { not: 'onlyMe' }, ...this.notDeletedWhere() },
            _count: { _all: true },
          });

          const out: PostCounts = {
            all: 0,
            public: 0,
            verifiedOnly: 0,
            premiumOnly: 0,
          };
          for (const g of grouped) {
            const n = g._count._all;
            out.all += n;
            if (g.visibility === 'public') out.public = n;
            if (g.visibility === 'verifiedOnly') out.verifiedOnly = n;
            if (g.visibility === 'premiumOnly') out.premiumOnly = n;
          }
          return out;
        })()
      : null;

    const allowed =
      isSelf ? (['public', 'verifiedOnly', 'premiumOnly'] as PostVisibility[]) : this.allowedVisibilitiesForViewer(viewer);

    if (visibility === 'verifiedOnly' && !isSelf) {
      if (!viewer || viewer.verifiedStatus === 'none') throw new ForbiddenException('Verify to view verified-only posts.');
    }
    if (visibility === 'premiumOnly' && !isSelf) {
      if (!viewer || !viewer.premium) throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
    }

    const baseWhere =
      visibility === 'all'
        ? ({ userId: user.id, visibility: { in: allowed }, ...this.notDeletedWhere() } as Prisma.PostWhereInput)
        : ({ userId: user.id, visibility, ...this.notDeletedWhere() } as Prisma.PostWhereInput);

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const posts = await this.prisma.post.findMany({
      where: { AND: [baseWhere, ...(cursorWhere ? [cursorWhere] : [])] },
      include: { user: true, media: { orderBy: { position: 'asc' } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = posts.slice(0, limit);
    const nextCursor = posts.length > limit ? slice[slice.length - 1]?.id ?? null : null;

    return { posts: slice, nextCursor, counts };
  }

  async getById(params: { viewerUserId: string | null; id: string }) {
    const { viewerUserId, id } = params;
    const postId = (id ?? '').trim();
    if (!postId) throw new NotFoundException('Post not found.');

    const viewer = await this.viewerById(viewerUserId);
    const allowed = this.allowedVisibilitiesForViewer(viewer);

    // Guardrail: deleted posts should behave as "not found" everywhere.
    const post = await this.prisma.post.findFirst({
      where: { id: postId, ...this.notDeletedWhere() },
      include: { user: true, media: { orderBy: { position: 'asc' } } },
    });
    if (!post) throw new NotFoundException('Post not found.');

    // Author can always view their own posts.
    const isSelf = Boolean(viewer && viewer.id === post.userId);
    if (!isSelf) {
      // Only-me posts are private. Allow site admins to view for support/moderation.
      if (post.visibility === 'onlyMe' && !viewer?.siteAdmin) throw new ForbiddenException('This post is private.');
      if (!allowed.includes(post.visibility)) {
        if (post.visibility === 'verifiedOnly') throw new ForbiddenException('Verify to view verified-only posts.');
        if (post.visibility === 'premiumOnly') throw new ForbiddenException('Upgrade to premium to view premium-only posts.');
        throw new ForbiddenException('Not allowed to view this post.');
      }
    }

    return post;
  }

  async deletePost(params: { userId: string; postId: string }) {
    const { userId, postId } = params;
    const id = (postId ?? '').trim();
    if (!id) throw new NotFoundException('Post not found.');

    const post = await this.prisma.post.findUnique({
      where: { id },
      select: { id: true, userId: true, deletedAt: true },
    });
    if (!post) throw new NotFoundException('Post not found.');
    if (post.userId !== userId) throw new ForbiddenException('Not allowed to delete this post.');
    if (post.deletedAt) return { success: true };

    await this.prisma.post.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { success: true };
  }

  async createPost(params: {
    userId: string;
    body: string;
    visibility: PostVisibility;
    media: Array<{
      source: 'upload' | 'giphy';
      kind: 'image' | 'gif';
      r2Key?: string;
      url?: string;
      mp4Url?: string;
      width?: number;
      height?: number;
    }> | null;
  }) {
    const { userId, body, visibility } = params;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { verifiedStatus: true, premium: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    // Unverified members can post to "Only me" (private drafts / journaling), but nothing else.
    if (user.verifiedStatus === 'none' && visibility !== 'onlyMe') {
      throw new ForbiddenException('Verify your account to post publicly.');
    }
    if (visibility === 'premiumOnly' && !user.premium) {
      throw new ForbiddenException('Upgrade to premium to create premium-only posts.');
    }

    const cfg = await this.getSiteConfig();
    const windowStart = new Date(Date.now() - cfg.windowSeconds * 1000);
    const recentCount = await this.prisma.post.count({
      where: { userId, createdAt: { gte: windowStart } },
    });
    if (recentCount >= cfg.postsPerWindow) {
      const minutes = Math.max(1, Math.round(cfg.windowSeconds / 60));
      const minuteLabel = minutes === 1 ? 'minute' : 'minutes';
      throw new HttpException(
        `You are posting too often. You can make up to ${cfg.postsPerWindow} posts every ${minutes} ${minuteLabel}.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const maxLen = user.premium ? 500 : 200;
    if (body.length > maxLen) {
      throw new BadRequestException(
        user.premium
          ? 'Posts are limited to 500 characters.'
          : 'Posts are limited to 200 characters for non-premium members.',
      );
    }

    const media = (params.media ?? []).filter(Boolean);
    if (media.length > 4) throw new BadRequestException('You can attach up to 4 images/GIFs.');

    const cleanedMedia = media
      .map((m, idx) => {
        const source = m.source;
        const kind = m.kind;
        const r2Key = (m.r2Key ?? '').trim();
        const url = (m.url ?? '').trim();
        const mp4Url = (m.mp4Url ?? '').trim();
        const width = typeof m.width === 'number' && Number.isFinite(m.width) ? Math.max(1, Math.floor(m.width)) : null;
        const height = typeof m.height === 'number' && Number.isFinite(m.height) ? Math.max(1, Math.floor(m.height)) : null;

        if (source === 'upload') {
          if (!r2Key) throw new BadRequestException('Invalid uploaded media key.');
          // Best-effort guardrail: uploaded post media keys must be namespaced by user.
          const allowedPrefixes = [`uploads/${userId}/images/`, `dev/uploads/${userId}/images/`];
          if (!allowedPrefixes.some((p) => r2Key.startsWith(p))) {
            throw new BadRequestException('Invalid uploaded media key.');
          }
          return { source, kind, r2Key, url: null, mp4Url: null, width, height, position: idx };
        }

        if (!url) throw new BadRequestException('Invalid Giphy media URL.');
        return { source, kind, r2Key: null, url, mp4Url: mp4Url || null, width, height, position: idx };
      })
      .filter(Boolean);

    return await this.prisma.post.create({
      data: {
        body,
        visibility,
        userId,
        ...(cleanedMedia.length
          ? {
              media: {
                create: cleanedMedia,
              },
            }
          : {}),
      },
      include: { user: true, media: { orderBy: { position: 'asc' } } },
    });
  }

  private async ensureUserCanBoost(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, usernameIsSet: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (!user.usernameIsSet) throw new ForbiddenException('Set a username to boost posts.');
  }

  async boostPost(params: { userId: string; postId: string }) {
    const { userId, postId } = params;
    const id = (postId ?? '').trim();
    if (!id) throw new NotFoundException('Post not found.');

    await this.ensureUserCanBoost(userId);

    const post = await this.getById({ viewerUserId: userId, id });
    if (post.visibility === 'onlyMe') throw new BadRequestException('Only-me posts cannot be boosted.');

    const res = await this.prisma.$transaction(async (tx) => {
      const created = await tx.boost.createMany({
        data: [{ postId: id, userId }],
        skipDuplicates: true,
      });

      if (created.count === 1) {
        await tx.post.update({
          where: { id },
          data: {
            boostCount: { increment: 1 },
            boostScore: null,
            boostScoreUpdatedAt: null,
          },
        });
      }

      const updated = await tx.post.findUnique({
        where: { id },
        select: { boostCount: true },
      });

      return {
        boostCount: updated?.boostCount ?? 0,
      };
    });

    return { success: true, viewerHasBoosted: true, boostCount: res.boostCount };
  }

  async unboostPost(params: { userId: string; postId: string }) {
    const { userId, postId } = params;
    const id = (postId ?? '').trim();
    if (!id) throw new NotFoundException('Post not found.');

    await this.ensureUserCanBoost(userId);

    const post = await this.getById({ viewerUserId: userId, id });
    if (post.visibility === 'onlyMe') throw new BadRequestException('Only-me posts cannot be boosted.');

    const res = await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.boost.deleteMany({
        where: { postId: id, userId },
      });

      if (deleted.count === 1) {
        await tx.post.update({
          where: { id },
          data: {
            boostCount: { decrement: 1 },
            boostScore: null,
            boostScoreUpdatedAt: null,
          },
        });
      }

      const updated = await tx.post.findUnique({
        where: { id },
        select: { boostCount: true },
      });

      return {
        boostCount: updated?.boostCount ?? 0,
      };
    });

    return { success: true, viewerHasBoosted: false, boostCount: res.boostCount };
  }
}

