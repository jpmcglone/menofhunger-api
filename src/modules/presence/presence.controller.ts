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

function decodeCursor(raw: string): { tMs: number; id: string } | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  try {
    const json = Buffer.from(s, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { tMs?: unknown; id?: unknown };
    const tMs = typeof parsed?.tMs === 'number' && Number.isFinite(parsed.tMs) ? Math.floor(parsed.tMs) : null;
    const id = typeof parsed?.id === 'string' ? parsed.id.trim() : '';
    if (!tMs || !id) return null;
    return { tMs, id };
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
    if (viewerUserId && !includeSelf) {
      userIds = userIds.filter((id) => id !== viewerUserId);
    }

    // Sort by longest online first (earliest connect time first).
    const lastConnectAtById = await this.presenceRedis.lastConnectAtMsByUserId(userIds);
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
    const cursor = decodeCursor(cursorRaw);
    if (cursorRaw && !cursor) throw new BadRequestException('Invalid cursor.');

    // Exclude currently-online users so "Recently online" is truly "recently" (offline users).
    const onlineIds = await this.presenceRedis.onlineUserIds();

    const items = await this.prisma.user.findMany({
      where: {
        usernameIsSet: true,
        lastOnlineAt: { not: null },
        ...(onlineIds.length ? { id: { notIn: onlineIds } } : {}),
        ...(cursor
          ? {
              // Cursor is a {tMs,id} pair; build deterministic paging that matches ORDER BY lastOnlineAt DESC, id DESC.
              // Note: compute cursorDate inside this branch so it is always a Date (never null/undefined).
              // (Prisma filters disallow lt: null.)
              ...((
                () => {
                  const cursorDate = new Date(cursor.tMs);
                  return {
                    OR: [
                      { lastOnlineAt: { lt: cursorDate } },
                      { lastOnlineAt: cursorDate, id: { lt: cursor.id } },
                    ],
                  };
                }
              )()),
            }
          : {}),
      },
      orderBy: [{ lastOnlineAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        lastOnlineAt: true,
      },
    });

    const page = items.slice(0, limit);
    const next = items.length > limit ? items[limit] : null;

    const userIds = page.map((r) => r.id);
    const followListUsers = userIds.length
      ? await this.follows.getFollowListUsersByIds({ viewerUserId, userIds })
      : [];

    // Preserve order: most recently online first.
    const orderMap = new Map(userIds.map((id, i) => [id, i]));
    followListUsers.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));

    const lastOnlineAtById = new Map<string, string | null>(
      page.map((r) => [r.id, r.lastOnlineAt ? r.lastOnlineAt.toISOString() : null]),
    );

    const data: RecentlyOnlineUserDto[] = followListUsers.map((u) => ({
      ...(u as any),
      lastOnlineAt: lastOnlineAtById.get(u.id) ?? null,
    }));

    return {
      data,
      pagination: {
        nextCursor: next?.lastOnlineAt
          ? encodeCursor({ tMs: next.lastOnlineAt.getTime(), id: next.id })
          : null,
      },
    };
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
    if (viewerUserId && !includeSelf) {
      onlineUserIds = onlineUserIds.filter((id) => id !== viewerUserId);
    }

    // Sort by longest online first (earliest connect time first).
    const lastConnectAtById = await this.presenceRedis.lastConnectAtMsByUserId(onlineUserIds);
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
        const cursor = decodeCursor(cursorRaw);
        if (cursorRaw && !cursor) throw new BadRequestException('Invalid cursor.');

        // Exclude currently-online users so "Recently online" is truly "recently" (offline users).
        const onlineIds = onlineUserIds.length ? onlineUserIds : await this.presenceRedis.onlineUserIds();

        const items = await this.prisma.user.findMany({
          where: {
            usernameIsSet: true,
            lastOnlineAt: { not: null },
            ...(onlineIds.length ? { id: { notIn: onlineIds } } : {}),
            ...(cursor
              ? {
                  ...((
                    () => {
                      const cursorDate = new Date(cursor.tMs);
                      return {
                        OR: [
                          { lastOnlineAt: { lt: cursorDate } },
                          { lastOnlineAt: cursorDate, id: { lt: cursor.id } },
                        ],
                      };
                    }
                  )()),
                }
              : {}),
          },
          orderBy: [{ lastOnlineAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          select: {
            id: true,
            lastOnlineAt: true,
          },
        });

        const page = items.slice(0, limit);
        const next = items.length > limit ? items[limit] : null;
        recentNextCursor = next?.lastOnlineAt ? encodeCursor({ tMs: next.lastOnlineAt.getTime(), id: next.id }) : null;

        const recentUserIds = page.map((r) => r.id);
        const followListUsers = recentUserIds.length
          ? await this.follows.getFollowListUsersByIds({ viewerUserId, userIds: recentUserIds })
          : [];

        // Preserve order: most recently online first.
        const recentOrderMap = new Map(recentUserIds.map((id, i) => [id, i]));
        followListUsers.sort((a, b) => (recentOrderMap.get(a.id) ?? 999) - (recentOrderMap.get(b.id) ?? 999));

        const lastOnlineAtById = new Map<string, string | null>(
          page.map((r) => [r.id, r.lastOnlineAt ? r.lastOnlineAt.toISOString() : null]),
        );

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
