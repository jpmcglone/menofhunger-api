import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { OptionalCurrentUserId } from '../users/users.decorator';
import { Throttle } from '@nestjs/throttler';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { FollowsService } from '../follows/follows.service';
import { PresenceRedisStateService } from './presence-redis-state.service';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import type { PresenceOnlinePageDto, RecentlyOnlineUserDto } from '../../common/dto';
import { PrismaService } from '../prisma/prisma.service';

const recentSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

const onlinePageSchema = z.object({
  includeSelf: z.string().optional(),
  recentLimit: z.coerce.number().int().min(1).max(50).optional(),
  recentCursor: z.string().optional(),
});

function encodeCursor(params: { tMs: number; id: string }): string {
  return Buffer.from(JSON.stringify(params), 'utf8').toString('base64url');
}

function encodeNeverCursor(params: { cMs: number; id: string }): string {
  return Buffer.from(JSON.stringify({ section: 'never', cMs: params.cMs, id: params.id }), 'utf8').toString('base64url');
}

/**
 * Decodes either a section-A cursor { tMs, id } (backward-compat) or a
 * section-B cursor { section: 'never', cMs, id }.
 */
function decodePageCursor(
  raw: string,
): { section: 'recent'; tMs: number; id: string } | { section: 'never'; cMs: number | null; id: string | null } | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  try {
    const json = Buffer.from(s, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed?.section === 'never') {
      const cMs = typeof parsed.cMs === 'number' && Number.isFinite(parsed.cMs) ? Math.floor(parsed.cMs) : null;
      const id = typeof parsed.id === 'string' ? parsed.id.trim() || null : null;
      return { section: 'never', cMs, id };
    }
    // Section A (recent online): backward-compat format { tMs, id }
    const tMs = typeof parsed?.tMs === 'number' && Number.isFinite(parsed.tMs) ? Math.floor(parsed.tMs) : null;
    const id = typeof parsed?.id === 'string' ? parsed.id.trim() : '';
    if (!tMs || !id) return null;
    return { section: 'recent', tMs, id };
  } catch {
    return null;
  }
}

@Controller('presence')
export class PresenceController {
  constructor(
    private readonly presenceRedis: PresenceRedisStateService,
    private readonly follows: FollowsService,
    private readonly prisma: PrismaService,
  ) {}

  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 60),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Get('online')
  async online(
    @OptionalCurrentUserId() userId: string | undefined,
    @Query('includeSelf') includeSelfRaw?: string,
  ) {
    const viewerUserId = userId ?? null;
    // Default: include the viewer in "Online now" counts.
    // Keep the query param for backwards compatibility (includeSelf=0/false will exclude).
    const includeSelf =
      includeSelfRaw == null ? true : (includeSelfRaw === '1' || includeSelfRaw === 'true');
    let userIds = await this.presenceRedis.onlineUserIds();
    if (viewerUserId) {
      if (!includeSelf) {
        userIds = userIds.filter((id) => id !== viewerUserId);
      } else if (!userIds.includes(viewerUserId)) {
        // Race hardening: if the viewer just loaded the app, their websocket may not have
        // registered in Redis yet. Treat the request itself as proof of current activity.
        userIds = [viewerUserId, ...userIds];
      }
    }

    // Sort by longest online first (earliest connect time first).
    const lastConnectAtById = await this.presenceRedis.lastConnectAtMsByUserId(userIds);
    if (viewerUserId && includeSelf && !lastConnectAtById.has(viewerUserId)) {
      lastConnectAtById.set(viewerUserId, Date.now());
    }
    userIds = userIds
      .slice()
      .sort((a, b) => {
        const aAt = lastConnectAtById.get(a) ?? null;
        const bAt = lastConnectAtById.get(b) ?? null;
        const aKey = typeof aAt === 'number' && Number.isFinite(aAt) ? aAt : Number.POSITIVE_INFINITY;
        const bKey = typeof bAt === 'number' && Number.isFinite(bAt) ? bAt : Number.POSITIVE_INFINITY;
        if (aKey !== bKey) return aKey - bKey;
        return a.localeCompare(b);
      });
    const users = await this.follows.getFollowListUsersByIds({
      viewerUserId,
      userIds,
    });
    const orderMap = new Map(userIds.map((id, i) => [id, i]));
    users.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
    const idleById = await this.presenceRedis.idleByUserIds(userIds);
    const data = users.map((u) => ({
      ...u,
      lastConnectAt: lastConnectAtById.get(u.id),
      idle: idleById.get(u.id) ?? false,
    }));
    return { data, pagination: { totalOnline: userIds.length } };
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 60),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Get('recent')
  async recent(
    @OptionalCurrentUserId() userId: string | undefined,
    @Query() query: unknown,
  ): Promise<{ data: RecentlyOnlineUserDto[]; pagination: { nextCursor: string | null } }> {
    const viewerUserId = userId ?? null;

    // Privacy: only verified viewers can see "recently online" / last-online timestamps.
    // (Unverified viewers should not be able to infer last-online recency ordering.)
    if (!viewerUserId) {
      return { data: [], pagination: { nextCursor: null } };
    }
    const viewer = await this.prisma.user.findUnique({
      where: { id: viewerUserId },
      select: { verifiedStatus: true, siteAdmin: true },
    });
    const viewerVerifiedStatus = (viewer as any)?.verifiedStatus ?? 'none';
    const viewerCanSeeLastOnline =
      Boolean((viewer as any)?.siteAdmin) || (typeof viewerVerifiedStatus === 'string' && viewerVerifiedStatus !== 'none');
    if (!viewerCanSeeLastOnline) {
      return { data: [], pagination: { nextCursor: null } };
    }

    const parsed = recentSchema.parse(query);
    const limit = parsed.limit ?? 30;
    const cursorRaw = (parsed.cursor ?? '').trim();
    const cursor = decodePageCursor(cursorRaw);
    if (cursorRaw && !cursor) throw new BadRequestException('Invalid cursor.');

    // Exclude currently-online users so "Recently online" is truly "recently" (offline users).
    const onlineIds = await this.presenceRedis.onlineUserIds();
    const onlineFilter = onlineIds.length ? { id: { notIn: onlineIds } } : {};

    let pageItems: Array<{ id: string; lastOnlineAt: string | null }> = [];
    let nextCursor: string | null = null;

    if (cursor?.section !== 'never') {
      // ── Section A: users with a known lastOnlineAt, newest → oldest ──
      const aItems = await this.prisma.user.findMany({
        where: {
          usernameIsSet: true,
          bannedAt: null,
          lastOnlineAt: { not: null },
          ...onlineFilter,
          ...(cursor
            ? {
                OR: [
                  { lastOnlineAt: { lt: new Date(cursor.tMs) } },
                  { lastOnlineAt: new Date(cursor.tMs), id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ lastOnlineAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: { id: true, lastOnlineAt: true },
      });

      const aHasMore = aItems.length > limit;
      const aPage = aItems.slice(0, limit);

      if (aHasMore) {
        const aNext = aItems[limit];
        nextCursor = encodeCursor({ tMs: aNext.lastOnlineAt!.getTime(), id: aNext.id });
        pageItems = aPage.map((r) => ({ id: r.id, lastOnlineAt: r.lastOnlineAt ? r.lastOnlineAt.toISOString() : null }));
      } else {
        // Section A exhausted — fill remainder of page with section B (never-online users).
        const remaining = limit - aPage.length;
        const bItems = await this.prisma.user.findMany({
          where: {
            usernameIsSet: true,
            bannedAt: null,
            lastOnlineAt: null,
            ...onlineFilter,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: remaining + 1,
          select: { id: true, createdAt: true },
        });

        const bHasMore = bItems.length > remaining;
        const bPage = bItems.slice(0, remaining);

        if (bHasMore) {
          const bNext = bItems[remaining];
          nextCursor = encodeNeverCursor({ cMs: bNext.createdAt.getTime(), id: bNext.id });
        }

        pageItems = [
          ...aPage.map((r) => ({ id: r.id, lastOnlineAt: r.lastOnlineAt ? r.lastOnlineAt.toISOString() : null })),
          ...bPage.map((r) => ({ id: r.id, lastOnlineAt: null as string | null })),
        ];
      }
    } else {
      // ── Section B: users with no lastOnlineAt, sorted by newest account first ──
      const { cMs, id: cId } = cursor;
      const bItems = await this.prisma.user.findMany({
        where: {
          usernameIsSet: true,
          bannedAt: null,
          lastOnlineAt: null,
          ...onlineFilter,
          ...(cMs != null && cId != null
            ? {
                OR: [
                  { createdAt: { lt: new Date(cMs) } },
                  { createdAt: new Date(cMs), id: { lt: cId } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: { id: true, createdAt: true },
      });

      const bHasMore = bItems.length > limit;
      const bPage = bItems.slice(0, limit);

      if (bHasMore) {
        const bNext = bItems[limit];
        nextCursor = encodeNeverCursor({ cMs: bNext.createdAt.getTime(), id: bNext.id });
      }

      pageItems = bPage.map((r) => ({ id: r.id, lastOnlineAt: null as string | null }));
    }

    const userIds = pageItems.map((r) => r.id);
    const followListUsers = userIds.length
      ? await this.follows.getFollowListUsersByIds({ viewerUserId, userIds })
      : [];

    const orderMap = new Map(userIds.map((id, i) => [id, i]));
    followListUsers.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));

    const lastOnlineAtById = new Map<string, string | null>(pageItems.map((r) => [r.id, r.lastOnlineAt]));
    const data: RecentlyOnlineUserDto[] = followListUsers.map((u) => ({
      ...(u as any),
      lastOnlineAt: lastOnlineAtById.get(u.id) ?? null,
    }));

    return { data, pagination: { nextCursor } };
  }

  /**
   * Combined payload for /online page: online snapshot + total count + first page of "recently online".
   * Keeps a single server snapshot so counts/lists stay consistent.
   */
  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 60),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Get('online-page')
  async onlinePage(
    @OptionalCurrentUserId() userId: string | undefined,
    @Query() query: unknown,
  ): Promise<{ data: PresenceOnlinePageDto; pagination: { totalOnline: number; recentNextCursor: string | null } }> {
    const viewerUserId = userId ?? null;
    const parsed = onlinePageSchema.parse(query);

    // Default: include the viewer in "Online now" counts.
    // Keep includeSelf for backwards compatibility with /presence/online.
    const includeSelfRaw = (parsed.includeSelf ?? '').trim();
    const includeSelf = includeSelfRaw ? includeSelfRaw === '1' || includeSelfRaw === 'true' : true;

    // ——— Online snapshot ———
    let onlineUserIds = await this.presenceRedis.onlineUserIds();
    if (viewerUserId) {
      if (!includeSelf) {
        onlineUserIds = onlineUserIds.filter((id) => id !== viewerUserId);
      } else if (!onlineUserIds.includes(viewerUserId)) {
        // Race hardening: keep /online consistent with right-rail count even if the
        // viewer's websocket hasn't yet registered as online in Redis.
        onlineUserIds = [viewerUserId, ...onlineUserIds];
      }
    }

    // Sort by longest online first (earliest connect time first).
    const lastConnectAtById = await this.presenceRedis.lastConnectAtMsByUserId(onlineUserIds);
    if (viewerUserId && includeSelf && !lastConnectAtById.has(viewerUserId)) {
      lastConnectAtById.set(viewerUserId, Date.now());
    }
    onlineUserIds = onlineUserIds
      .slice()
      .sort((a, b) => {
        const aAt = lastConnectAtById.get(a) ?? null;
        const bAt = lastConnectAtById.get(b) ?? null;
        const aKey = typeof aAt === 'number' && Number.isFinite(aAt) ? aAt : Number.POSITIVE_INFINITY;
        const bKey = typeof bAt === 'number' && Number.isFinite(bAt) ? bAt : Number.POSITIVE_INFINITY;
        if (aKey !== bKey) return aKey - bKey;
        return a.localeCompare(b);
      });

    const onlineUsers = await this.follows.getFollowListUsersByIds({
      viewerUserId,
      userIds: onlineUserIds,
    });
    const orderMap = new Map(onlineUserIds.map((id, i) => [id, i]));
    onlineUsers.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
    const idleById = await this.presenceRedis.idleByUserIds(onlineUserIds);

    const onlineData = onlineUsers.map((u) => ({
      ...(u as any),
      lastConnectAt: lastConnectAtById.get(u.id) ?? null,
      idle: idleById.get(u.id) ?? false,
    }));

    // ——— Recently online (privacy-gated, cursor-paginated) ———
    let recentData: RecentlyOnlineUserDto[] = [];
    let recentNextCursor: string | null = null;

    if (viewerUserId) {
      const viewer = await this.prisma.user.findUnique({
        where: { id: viewerUserId },
        select: { verifiedStatus: true, siteAdmin: true },
      });
      const viewerVerifiedStatus = (viewer as any)?.verifiedStatus ?? 'none';
      const viewerCanSeeLastOnline =
        Boolean((viewer as any)?.siteAdmin) ||
        (typeof viewerVerifiedStatus === 'string' && viewerVerifiedStatus !== 'none');

      if (viewerCanSeeLastOnline) {
        const limit = parsed.recentLimit ?? 30;
        const cursorRaw = (parsed.recentCursor ?? '').trim();
        const cursor = decodePageCursor(cursorRaw);
        if (cursorRaw && !cursor) throw new BadRequestException('Invalid cursor.');

        // Exclude currently-online users so "Recently online" is truly "recently" (offline users).
        const onlineIds = onlineUserIds.length ? onlineUserIds : await this.presenceRedis.onlineUserIds();
        const onlineFilter = onlineIds.length ? { id: { notIn: onlineIds } } : {};

        let pageItems: Array<{ id: string; lastOnlineAt: string | null }> = [];

        if (cursor?.section !== 'never') {
          // ── Section A: users with a known lastOnlineAt, newest → oldest ──
          const aItems = await this.prisma.user.findMany({
            where: {
              usernameIsSet: true,
              bannedAt: null,
              lastOnlineAt: { not: null },
              ...onlineFilter,
              ...(cursor
                ? {
                    OR: [
                      { lastOnlineAt: { lt: new Date(cursor.tMs) } },
                      { lastOnlineAt: new Date(cursor.tMs), id: { lt: cursor.id } },
                    ],
                  }
                : {}),
            },
            orderBy: [{ lastOnlineAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            select: { id: true, lastOnlineAt: true },
          });

          const aHasMore = aItems.length > limit;
          const aPage = aItems.slice(0, limit);

          if (aHasMore) {
            const aNext = aItems[limit];
            recentNextCursor = encodeCursor({ tMs: aNext.lastOnlineAt!.getTime(), id: aNext.id });
            pageItems = aPage.map((r) => ({ id: r.id, lastOnlineAt: r.lastOnlineAt ? r.lastOnlineAt.toISOString() : null }));
          } else {
            // Section A exhausted — fill remainder of page with section B (never-online users).
            const remaining = limit - aPage.length;
            const bItems = await this.prisma.user.findMany({
              where: {
                usernameIsSet: true,
                bannedAt: null,
                lastOnlineAt: null,
                ...onlineFilter,
              },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: remaining + 1,
              select: { id: true, createdAt: true },
            });

            const bHasMore = bItems.length > remaining;
            const bPage = bItems.slice(0, remaining);

            if (bHasMore) {
              const bNext = bItems[remaining];
              recentNextCursor = encodeNeverCursor({ cMs: bNext.createdAt.getTime(), id: bNext.id });
            }

            pageItems = [
              ...aPage.map((r) => ({ id: r.id, lastOnlineAt: r.lastOnlineAt ? r.lastOnlineAt.toISOString() : null })),
              ...bPage.map((r) => ({ id: r.id, lastOnlineAt: null as string | null })),
            ];
          }
        } else {
          // ── Section B: users with no lastOnlineAt, sorted by newest account first ──
          const { cMs, id: cId } = cursor;
          const bItems = await this.prisma.user.findMany({
            where: {
              usernameIsSet: true,
              bannedAt: null,
              lastOnlineAt: null,
              ...onlineFilter,
              ...(cMs != null && cId != null
                ? {
                    OR: [
                      { createdAt: { lt: new Date(cMs) } },
                      { createdAt: new Date(cMs), id: { lt: cId } },
                    ],
                  }
                : {}),
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            select: { id: true, createdAt: true },
          });

          const bHasMore = bItems.length > limit;
          const bPage = bItems.slice(0, limit);

          if (bHasMore) {
            const bNext = bItems[limit];
            recentNextCursor = encodeNeverCursor({ cMs: bNext.createdAt.getTime(), id: bNext.id });
          }

          pageItems = bPage.map((r) => ({ id: r.id, lastOnlineAt: null as string | null }));
        }

        const recentUserIds = pageItems.map((r) => r.id);
        const followListUsers = recentUserIds.length
          ? await this.follows.getFollowListUsersByIds({ viewerUserId, userIds: recentUserIds })
          : [];

        const recentOrderMap = new Map(recentUserIds.map((id, i) => [id, i]));
        followListUsers.sort((a, b) => (recentOrderMap.get(a.id) ?? 999) - (recentOrderMap.get(b.id) ?? 999));

        const lastOnlineAtById = new Map<string, string | null>(pageItems.map((r) => [r.id, r.lastOnlineAt]));
        recentData = followListUsers.map((u) => ({
          ...(u as any),
          lastOnlineAt: lastOnlineAtById.get(u.id) ?? null,
        }));
      }
    }

    return {
      data: {
        online: onlineData,
        recent: recentData,
      },
      pagination: {
        totalOnline: onlineUserIds.length,
        recentNextCursor,
      },
    };
  }
}
