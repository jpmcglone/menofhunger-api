import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { OptionalCurrentUserId } from '../users/users.decorator';
import { Throttle } from '@nestjs/throttler';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { FollowsService } from '../follows/follows.service';
import { PresenceService } from './presence.service';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import type { RecentlyOnlineUserDto } from '../../common/dto';
import { PrismaService } from '../prisma/prisma.service';

const recentSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
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
    private readonly presence: PresenceService,
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
    let userIds = this.presence.getOnlineUserIds();
    if (viewerUserId && !includeSelf) {
      userIds = userIds.filter((id) => id !== viewerUserId);
    }

    // Sort by longest online first (earliest connect time first).
    userIds = userIds
      .slice()
      .sort((a, b) => {
        const aAt = this.presence.getLastConnectAt(a);
        const bAt = this.presence.getLastConnectAt(b);
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
    const lastConnectAtById = new Map(userIds.map((id) => [id, this.presence.getLastConnectAt(id) ?? null]));
    const idleById = new Map(userIds.map((id) => [id, this.presence.isUserIdle(id)]));
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
    const onlineIds = this.presence.getOnlineUserIds();

    const cursorDate = cursor ? new Date(cursor.tMs) : null;
    const items = await this.prisma.user.findMany({
      where: {
        usernameIsSet: true,
        lastOnlineAt: { not: null },
        ...(onlineIds.length ? { id: { notIn: onlineIds } } : {}),
        ...(cursorDate
          ? {
              OR: [
                { lastOnlineAt: { lt: cursorDate } },
                { lastOnlineAt: cursorDate, id: { lt: cursor.id } },
              ],
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
}
