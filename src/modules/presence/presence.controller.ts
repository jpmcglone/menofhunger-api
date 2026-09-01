import { BadRequestException, Body, Controller, Delete, Get, Patch, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
import { Throttle } from '@nestjs/throttler';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { AuthGuard } from '../auth/auth.guard';
import { VerifiedGuard } from '../auth/verified.guard';
import { AppConfigService } from '../app/app-config.service';
import { FollowsService } from '../follows/follows.service';
import { MarvinBotIdentityService } from '../marvin/services/marvin-bot-identity.service';
import { PresenceService } from './presence.service';
import { PresenceRealtimeService } from './presence-realtime.service';
import { PresenceRedisStateService } from './presence-redis-state.service';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import type { OnlinePaginationDto, OnlineUserDto, PresenceOnlinePageDto, RecentlyOnlineUserDto, UserStatusDto } from '../../common/dto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { PostsService } from '../posts/posts.service';
import { AccountSwitchService } from '../auth/account-switch.service';
import { CallSessionStore } from '../calls/call-session.store';

const ONLINE_LIST_CACHE_TTL_MS = 10_000;
const RECENTLY_ONLINE_WINDOW_MS = 60 * 60_000;

const recentSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

const onlinePageSchema = z.object({
  includeSelf: z.string().optional(),
  recentLimit: z.coerce.number().int().min(1).max(50).optional(),
  recentCursor: z.string().optional(),
});

const STATUS_DURATION_HOURS = [1, 3, 6, 12, 24] as const;
type StatusDurationHours = (typeof STATUS_DURATION_HOURS)[number];

const statusBodySchema = z.object({
  text: z.string().trim().min(1).max(120),
  durationHours: z
    .union(STATUS_DURATION_HOURS.map((h) => z.literal(h)) as [z.ZodLiteral<1>, z.ZodLiteral<3>, z.ZodLiteral<6>, z.ZodLiteral<12>, z.ZodLiteral<24>])
    .default(24),
  createsPost: z.boolean().default(true),
});

const editStatusBodySchema = z.object({
  text: z.string().trim().min(1).max(120),
});

function parseStatusUserIds(query: unknown): string[] {
  const raw = (query as any)?.userIds;
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return Array.from(new Set(parts.map((id) => String(id ?? '').trim()).filter(Boolean))).slice(0, 100);
}

function statusMap(statuses: UserStatusDto[]): Map<string, UserStatusDto> {
  return new Map(statuses.map((status) => [status.userId, status]));
}

function onlineTierCounts(rows: OnlineUserDto[]): Pick<
  OnlinePaginationDto,
  'premiumPlus' | 'premium' | 'verified' | 'unverified'
> {
  let premiumPlus = 0;
  let premium = 0;
  let verified = 0;
  let unverified = 0;
  for (const u of rows) {
    if (u.premiumPlus) premiumPlus += 1;
    else if (u.premium) premium += 1;
    else if (u.verifiedStatus && u.verifiedStatus !== 'none') verified += 1;
    else unverified += 1;
  }
  return { premiumPlus, premium, verified, unverified };
}

function isSummaryQuery(raw?: string): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

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
    private readonly presence: PresenceService,
    private readonly realtime: PresenceRealtimeService,
    private readonly follows: FollowsService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly appConfig: AppConfigService,
    private readonly marvIdentity: MarvinBotIdentityService,
    private readonly posts: PostsService,
    private readonly accountSwitch: AccountSwitchService,
    private readonly callSessions: CallSessionStore,
  ) {}

  /**
   * Connected sockets plus every operated page / operator in those clusters.
   * Synthetic identities inherit last-connect / idle / platforms from a live member.
   */
  private async expandDisplayedOnlineIds(connectedIds: string[]): Promise<{
    userIds: string[];
    sourceByDisplayedId: Map<string, string>;
  }> {
    const expanded = await this.accountSwitch.expandPresenceOnlineIds(connectedIds);
    return { userIds: expanded.displayedIds, sourceByDisplayedId: expanded.sourceByDisplayedId };
  }

  private inheritPresenceMaps(
    displayedIds: string[],
    sourceByDisplayedId: Map<string, string>,
    lastConnectAtById: Map<string, number | null>,
    idleById: Map<string, boolean>,
    platformsById: Map<string, string[]>,
  ): void {
    for (const id of displayedIds) {
      const source = sourceByDisplayedId.get(id) ?? id;
      if (!lastConnectAtById.has(id) || lastConnectAtById.get(id) == null) {
        lastConnectAtById.set(id, lastConnectAtById.get(source) ?? null);
      }
      if (!idleById.has(id)) idleById.set(id, idleById.get(source) ?? false);
      if (!platformsById.has(id)) platformsById.set(id, platformsById.get(source) ?? []);
    }
  }

  /**
   * Builds the synthetic Marv "always online" row when `MARV_ENABLED=true` and
   * the bot user has been resolved. Returns null otherwise (Marv hidden
   * entirely when disabled). The row is decorated with `isBot: true` so the
   * frontend can sort it to the top and add a small bot badge.
   */
  private async buildMarvOnlineRow(args: {
    viewerUserId: string | null;
    statusesById: Map<string, UserStatusDto>;
  }): Promise<OnlineUserDto | null> {
    if (!this.appConfig.marvBot().enabled) return null;
    const marvId = await this.marvIdentity.getMarvUserId();
    if (!marvId) return null;
    if (args.viewerUserId === marvId) return null; // Defensive: never list Marv as the viewer.
    const [marvUser] = await this.follows.getFollowListUsersByIds({
      viewerUserId: args.viewerUserId,
      userIds: [marvId],
    });
    if (!marvUser) return null;
    return {
      ...(marvUser as OnlineUserDto),
      // We sort online lists ascending by `lastConnectAt` (oldest connect first), so
      // pinning Marv requires a sentinel value the frontend will recognize. We use
      // the actual current timestamp here as a sane default for HTTP-only consumers,
      // and the frontend's sort treats `isBot` as the primary ordering key.
      lastConnectAt: Date.now(),
      idle: false,
      status: args.statusesById.get(marvId) ?? null,
      isBot: true,
    };
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 60),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Get('statuses')
  async statuses(@Query() query: unknown): Promise<{ data: UserStatusDto[] }> {
    const userIds = parseStatusUserIds(query);
    const data = await this.presence.getActiveStatuses(userIds);
    return { data };
  }

  // Setting your own status is a verified-only engagement feature. Everyone can
  // still read other users' statuses via GET /presence/statuses.
  @UseGuards(AuthGuard, VerifiedGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 20),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Put('status')
  async setStatus(@CurrentUserId() userId: string, @Body() body: unknown): Promise<{ data: UserStatusDto }> {
    const parsed = statusBodySchema.parse(body);
    const durationHours = (parsed.durationHours ?? 24) as StatusDurationHours;

    // When createsPost=true, create the feed post first then link it to the status.
    let statusPostId: string | null = null;
    if (parsed.createsPost) {
      const postResult = await this.posts.createPost({
        userId,
        body: parsed.text,
        visibility: 'public',
        media: null,
        poll: null,
        kind: 'status',
      });
      statusPostId = postResult.post.id;
    }

    // setStatus fans out a new status_update notification. The followed_post notification
    // is suppressed inside posts-mutation.service for kind=status posts so followers
    // don't receive two notifications for the same status.
    const status = await this.presence.setStatus(userId, parsed.text, durationHours, statusPostId);
    this.realtime.emitPresenceStatusUpdated(userId, { status });
    return { data: status };
  }

  @UseGuards(AuthGuard, VerifiedGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 20),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Patch('status')
  async editStatus(@CurrentUserId() userId: string, @Body() body: unknown): Promise<{ data: UserStatusDto }> {
    const parsed = editStatusBodySchema.parse(body);
    const { statusDto, statusPostId } = await this.presence.editStatus(userId, parsed.text);

    // If the status has a linked post, update its body in place.
    // isSiteAdmin bypasses the 30-min edit window and 3-edit limit — status posts
    // are system-managed and may be edited at any time while the status is active.
    if (statusPostId) {
      await this.posts.updatePost({ postId: statusPostId, userId, body: parsed.text, isSiteAdmin: true });
    }

    const status = statusDto;
    if (!status) {
      throw new BadRequestException('No active status to edit. Use PUT /presence/status to set a new one.');
    }
    this.realtime.emitPresenceStatusUpdated(userId, { status });
    return { data: status };
  }

  @UseGuards(AuthGuard, VerifiedGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 20),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete('status')
  async clearStatus(@CurrentUserId() userId: string): Promise<{ data: { cleared: true } }> {
    await this.presence.clearStatus(userId);
    this.realtime.emitPresenceStatusCleared(userId, { userId });
    return { data: { cleared: true } };
  }

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
    @Query('summary') summaryRaw?: string,
  ) {
    const viewerUserId = userId ?? null;
    const summary = isSummaryQuery(summaryRaw);
    // Default: include the viewer in "Online now" counts.
    // Keep the query param for backwards compatibility (includeSelf=0/false will exclude).
    const includeSelf =
      includeSelfRaw == null ? true : (includeSelfRaw === '1' || includeSelfRaw === 'true');

    const toResponse = (full: { data: OnlineUserDto[]; pagination: OnlinePaginationDto }) => {
      const pagination: OnlinePaginationDto = {
        ...full.pagination,
        ...onlineTierCounts(full.data),
      };
      if (summary) return { data: [] as OnlineUserDto[], pagination };
      return { data: full.data, pagination };
    };

    // Short-lived cache so rapid tab switches / reconnect polls don't hammer
    // getFollowListUsersByIds (User + relationship batch DB queries) on every call.
    // 10s is acceptable staleness for a "who's online" list.
    const cacheKey = RedisKeys.presenceOnlineList(viewerUserId);
    try {
      const cached = await this.redis.getJson<{ data: unknown[]; pagination: OnlinePaginationDto }>(cacheKey);
      if (cached) {
        const rows = cached.data as OnlineUserDto[];
        const platformsById = await this.presenceRedis.platformsByUserIds(rows.map((row) => row.id));
        const anonymousOnline = await this.presenceRedis.anonymousOnlineCount();
        return toResponse({
          data: rows.map((row) => ({
            ...row,
            platforms: row.isBot ? [] : (platformsById.get(row.id) ?? row.platforms ?? []),
          })),
          pagination: { ...cached.pagination, anonymousOnline },
        });
      }
    } catch {
      // Redis unavailable — fall through to live fetch.
    }

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
    const connectedIds = userIds;
    const expanded = await this.expandDisplayedOnlineIds(connectedIds);
    userIds = expanded.userIds;

    // The four downstream lookups are all keyed off the same `userIds` array
    // and don't depend on each other, so we run them concurrently. This trades
    // 4 sequential round-trips (Redis + Postgres + Redis + Postgres) for 1
    // wall-clock wait on the slowest of them.
    const [lastConnectAtById, users, idleById, activeStatuses, platformsById, anonymousOnline, inCallIds] = await Promise.all([
      this.presenceRedis.lastConnectAtMsByUserId(connectedIds),
      this.follows.getFollowListUsersByIds({ viewerUserId, userIds }),
      this.presenceRedis.idleByUserIds(connectedIds),
      this.presence.getActiveStatuses(userIds),
      this.presenceRedis.platformsByUserIds(connectedIds),
      this.presenceRedis.anonymousOnlineCount(),
      this.callSessions.inCallByUserIds(userIds),
    ]);
    this.inheritPresenceMaps(
      userIds,
      expanded.sourceByDisplayedId,
      lastConnectAtById,
      idleById,
      platformsById,
    );
    if (viewerUserId && includeSelf && !lastConnectAtById.has(viewerUserId)) {
      lastConnectAtById.set(viewerUserId, Date.now());
    }
    // Sort by longest online first (earliest connect time first).
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
    const orderMap = new Map(userIds.map((id, i) => [id, i]));
    users.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
    const statusesById = statusMap(activeStatuses);
    const data: OnlineUserDto[] = users.map((u) => ({
      ...(u as OnlineUserDto),
      lastConnectAt: lastConnectAtById.get(u.id) ?? null,
      idle: idleById.get(u.id) ?? false,
      status: statusesById.get(u.id) ?? null,
      platforms: platformsById.get(u.id) ?? [],
      inCall: inCallIds.has(u.id),
    }));

    // Pin Marv to the front when enabled, and bump totalOnline so the right-rail
    // count stays consistent with the list. The bot is a list-time injection only —
    // it never appears in `userIds` (Redis-tracked sockets) and we don't broadcast
    // synthetic online/offline events for it elsewhere.
    //
    // Use `users.length` (post-DB-fetch) instead of `userIds.length` so banned users —
    // which getFollowListUsersByIds filters out — don't inflate the count.
    let totalOnline = users.length;
    const marvRow = await this.buildMarvOnlineRow({ viewerUserId, statusesById });
    if (marvRow) {
      data.unshift(marvRow);
      totalOnline += 1;
    }

    // "Recently online" = active within the last hour but not currently connected.
    // Excludes everyone already counted in `totalOnline` so the two numbers never overlap.
    const recentlyOnlineCount = await this.prisma.user.count({
      where: {
        usernameIsSet: true,
        bannedAt: null,
        lastOnlineAt: { gte: new Date(Date.now() - RECENTLY_ONLINE_WINDOW_MS) },
        ...(userIds.length ? { id: { notIn: userIds } } : {}),
      },
    });

    const result = { data, pagination: { totalOnline, recentlyOnlineCount, anonymousOnline } };
    void this.redis.setJson(cacheKey, result, { ttlMs: ONLINE_LIST_CACHE_TTL_MS }).catch(() => undefined);
    return toResponse(result);
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

    // Require sign-in: anonymous visitors cannot see "recently online".
    if (!viewerUserId) {
      return { data: [], pagination: { nextCursor: null } };
    }

    const parsed = recentSchema.parse(query);
    const limit = parsed.limit ?? 30;
    const cursorRaw = (parsed.cursor ?? '').trim();
    const cursor = decodePageCursor(cursorRaw);
    if (cursorRaw && !cursor) throw new BadRequestException('Invalid cursor.');

    // Exclude currently-online users so "Recently online" is truly "recently" (offline users).
    const connectedIds = await this.presenceRedis.onlineUserIds();
    const { displayedIds } = await this.accountSwitch.expandPresenceOnlineIds(connectedIds);
    const onlineFilter = displayedIds.length ? { id: { notIn: displayedIds } } : {};

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
        // Section A exhausted — fill the remainder with users who have no presence history.
        // Their account creation time is the best available "last seen" fallback.
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
          ...bPage.map((r) => ({ id: r.id, lastOnlineAt: r.createdAt.toISOString() })),
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

      pageItems = bPage.map((r) => ({ id: r.id, lastOnlineAt: r.createdAt.toISOString() }));
    }

    const userIds = pageItems.map((r) => r.id);
    const followListUsers = userIds.length
      ? await this.follows.getFollowListUsersByIds({ viewerUserId, userIds })
      : [];

    const orderMap = new Map(userIds.map((id, i) => [id, i]));
    followListUsers.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));

    const lastOnlineAtById = new Map<string, string | null>(pageItems.map((r) => [r.id, r.lastOnlineAt]));
    const statusesById = statusMap(await this.presence.getActiveStatuses(userIds));
    const data: RecentlyOnlineUserDto[] = followListUsers.map((u) => ({
      ...(u as any),
      lastOnlineAt: lastOnlineAtById.get(u.id) ?? null,
      status: statusesById.get(u.id) ?? null,
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
  ): Promise<{
    data: PresenceOnlinePageDto;
    pagination: { totalOnline: number; anonymousOnline: number; recentNextCursor: string | null };
  }> {
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
    const connectedOnlineIds = onlineUserIds;
    const expandedOnline = await this.expandDisplayedOnlineIds(connectedOnlineIds);
    onlineUserIds = expandedOnline.userIds;

    // Same parallel-fan-out optimization as `/presence/online`: the four lookups
    // below all key off `onlineUserIds` and don't depend on each other, so we
    // run them concurrently to drop 3 round-trips of wall-clock wait.
    const [lastConnectAtById, onlineUsers, idleById, onlineStatuses, platformsById, anonymousOnline, inCallIds] =
      await Promise.all([
        this.presenceRedis.lastConnectAtMsByUserId(connectedOnlineIds),
        this.follows.getFollowListUsersByIds({ viewerUserId, userIds: onlineUserIds }),
        this.presenceRedis.idleByUserIds(connectedOnlineIds),
        this.presence.getActiveStatuses(onlineUserIds),
        this.presenceRedis.platformsByUserIds(connectedOnlineIds),
        this.presenceRedis.anonymousOnlineCount(),
        this.callSessions.inCallByUserIds(onlineUserIds),
      ]);
    this.inheritPresenceMaps(
      onlineUserIds,
      expandedOnline.sourceByDisplayedId,
      lastConnectAtById,
      idleById,
      platformsById,
    );
    if (viewerUserId && includeSelf && !lastConnectAtById.has(viewerUserId)) {
      lastConnectAtById.set(viewerUserId, Date.now());
    }
    // Sort by longest online first (earliest connect time first).
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
    const orderMap = new Map(onlineUserIds.map((id, i) => [id, i]));
    onlineUsers.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
    const onlineStatusesById = statusMap(onlineStatuses);

    const onlineData: OnlineUserDto[] = onlineUsers.map((u) => ({
      ...(u as OnlineUserDto),
      lastConnectAt: lastConnectAtById.get(u.id) ?? null,
      idle: idleById.get(u.id) ?? false,
      status: onlineStatusesById.get(u.id) ?? null,
      platforms: platformsById.get(u.id) ?? [],
      inCall: inCallIds.has(u.id),
    }));

    // Pin Marv to the top when enabled. Same rationale as in `online()`: the
    // bot is a list-time injection, totalOnline gets bumped to match the list.
    // Use `onlineUsers.length` so banned users (filtered out by getFollowListUsersByIds)
    // don't inflate the count.
    let totalOnline = onlineUsers.length;
    const marvRow = await this.buildMarvOnlineRow({
      viewerUserId,
      statusesById: onlineStatusesById,
    });
    if (marvRow) {
      onlineData.unshift(marvRow);
      totalOnline += 1;
    }

    // ——— Recently online (privacy-gated, cursor-paginated) ———
    let recentData: RecentlyOnlineUserDto[] = [];
    let recentNextCursor: string | null = null;

    if (viewerUserId) {
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
            // Section A exhausted — fill the remainder with users who have no presence history.
            // Their account creation time is the best available "last seen" fallback.
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
              ...bPage.map((r) => ({ id: r.id, lastOnlineAt: r.createdAt.toISOString() })),
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

          pageItems = bPage.map((r) => ({ id: r.id, lastOnlineAt: r.createdAt.toISOString() }));
        }

        const recentUserIds = pageItems.map((r) => r.id);
        const followListUsers = recentUserIds.length
          ? await this.follows.getFollowListUsersByIds({ viewerUserId, userIds: recentUserIds })
          : [];

        const recentOrderMap = new Map(recentUserIds.map((id, i) => [id, i]));
        followListUsers.sort((a, b) => (recentOrderMap.get(a.id) ?? 999) - (recentOrderMap.get(b.id) ?? 999));

        const lastOnlineAtById = new Map<string, string | null>(pageItems.map((r) => [r.id, r.lastOnlineAt]));
        const recentStatusesById = statusMap(await this.presence.getActiveStatuses(recentUserIds));
        recentData = followListUsers.map((u) => ({
          ...(u as any),
          lastOnlineAt: lastOnlineAtById.get(u.id) ?? null,
          status: recentStatusesById.get(u.id) ?? null,
        }));
    }

    return {
      data: {
        online: onlineData,
        recent: recentData,
      },
      pagination: {
        totalOnline,
        anonymousOnline,
        recentNextCursor,
      },
    };
  }
}
