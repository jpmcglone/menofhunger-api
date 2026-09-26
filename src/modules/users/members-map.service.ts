import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { PresenceRedisStateService } from '../presence/presence-redis-state.service';
import { toUserListDto, type UserListDto } from '../../common/dto';
import type { MembersMapStateDto, MembersMapSummaryDto } from '../../common/dto/members-map.dto';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { STATE_NAMES } from './users-location.service';

export const MEMBERS_MAP_MEMBER_WHERE = {
  usernameIsSet: true,
  bannedAt: null,
  isBot: false,
} satisfies Prisma.UserWhereInput;

export const MEMBERS_MAP_PREVIEW_SIZE = 6;
const ONLINE_FIRST_PAGE_MAX = 200;

/** `none` selects members without a location. */
export type MembersMapStateKey = string | 'none';

function stateKey(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toUpperCase();
  return s || null;
}

@Injectable()
export class MembersMapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRedis: PresenceRedisStateService,
  ) {}

  private get publicBaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  async summary(now: Date = new Date()): Promise<MembersMapSummaryDto> {
    const [groups, onlineIds, recentRows] = await Promise.all([
      this.prisma.user.groupBy({
        by: ['locationState'],
        where: MEMBERS_MAP_MEMBER_WHERE,
        _count: { _all: true },
      }),
      this.presenceRedis.onlineUserIds(),
      this.prisma.$queryRaw<Array<{ id: string; locationState: string | null }>>`
        SELECT "id", "locationState" FROM (
          SELECT "id", "locationState",
            ROW_NUMBER() OVER (
              PARTITION BY UPPER(COALESCE("locationState", ''))
              ORDER BY "lastOnlineAt" DESC NULLS LAST, "createdAt" ASC
            ) AS rn
          FROM "User"
          WHERE "usernameIsSet" = true AND "bannedAt" IS NULL AND "isBot" = false
        ) ranked
        WHERE rn <= ${MEMBERS_MAP_PREVIEW_SIZE}
      `,
    ]);

    const onlineRows = onlineIds.length
      ? await this.prisma.user.findMany({
          where: { ...MEMBERS_MAP_MEMBER_WHERE, id: { in: onlineIds } },
          select: { id: true, locationState: true },
        })
      : [];
    // Most recently connected first; the Redis set is ordered by connect time ascending.
    const onlineOrder = new Map(onlineIds.map((id, i) => [id, i]));
    onlineRows.sort((a, b) => (onlineOrder.get(b.id) ?? 0) - (onlineOrder.get(a.id) ?? 0));

    const memberCounts = new Map<string | null, number>();
    for (const g of groups) {
      const key = stateKey(g.locationState);
      memberCounts.set(key, (memberCounts.get(key) ?? 0) + g._count._all);
    }

    const onlineCounts = new Map<string | null, number>();
    const previewIds = new Map<string | null, string[]>();
    const pushPreview = (key: string | null, id: string) => {
      const list = previewIds.get(key) ?? [];
      if (list.length < MEMBERS_MAP_PREVIEW_SIZE && !list.includes(id)) list.push(id);
      previewIds.set(key, list);
    };
    for (const row of onlineRows) {
      const key = stateKey(row.locationState);
      onlineCounts.set(key, (onlineCounts.get(key) ?? 0) + 1);
      pushPreview(key, row.id);
    }
    for (const row of recentRows) pushPreview(stateKey(row.locationState), row.id);

    const allPreviewIds = [...new Set([...previewIds.values()].flat())];
    const previewUsers = allPreviewIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: allPreviewIds } }, select: USER_LIST_SELECT })
      : [];
    const byId = new Map(previewUsers.map((u) => [u.id, toUserListDto(u, this.publicBaseUrl)]));
    const previewFor = (key: string | null): UserListDto[] =>
      (previewIds.get(key) ?? []).map((id) => byId.get(id)).filter((u): u is UserListDto => Boolean(u));

    const states: MembersMapStateDto[] = [...memberCounts.entries()]
      .filter((entry): entry is [string, number] => entry[0] !== null && entry[1] > 0)
      .map(([state, memberCount]) => ({
        state,
        stateDisplay: STATE_NAMES[state] ?? state,
        memberCount,
        onlineCount: onlineCounts.get(state) ?? 0,
        preview: previewFor(state),
      }))
      .sort((a, b) => b.memberCount - a.memberCount || a.state.localeCompare(b.state));

    const unlocated = memberCounts.get(null) ?? 0;
    const locatedMembers = states.reduce((n, s) => n + s.memberCount, 0);

    return {
      states,
      online: onlineRows.map((r) => ({ userId: r.id, state: stateKey(r.locationState) })),
      totals: {
        members: locatedMembers + unlocated,
        states: states.length,
        online: onlineRows.length,
        unlocated,
        unlocatedOnline: onlineCounts.get(null) ?? 0,
      },
      unlocatedPreview: previewFor(null),
      asOf: now.toISOString(),
    };
  }

  /**
   * Members of one state (or `none`), most recently active first. The first page also
   * leads with everyone in that state who is online right now. The cursor is an offset
   * into the offline remainder; the client dedupes by id if presence shifts between pages.
   */
  async members(params: {
    state: MembersMapStateKey;
    cursor: string | null;
    limit: number;
  }): Promise<{ users: UserListDto[]; nextCursor: string | null }> {
    const { limit } = params;
    const offset = Math.max(0, Number.parseInt(params.cursor ?? '0', 10) || 0);
    const stateWhere: Prisma.UserWhereInput =
      params.state === 'none'
        ? { OR: [{ locationState: null }, { locationState: '' }] }
        : { locationState: { equals: params.state, mode: 'insensitive' } };

    const onlineIds = await this.presenceRedis.onlineUserIds();

    const onlineUsers =
      offset === 0 && onlineIds.length
        ? await this.prisma.user.findMany({
            where: { ...MEMBERS_MAP_MEMBER_WHERE, ...stateWhere, id: { in: onlineIds } },
            select: USER_LIST_SELECT,
            take: ONLINE_FIRST_PAGE_MAX,
          })
        : [];

    const rest = await this.prisma.user.findMany({
      where: {
        ...MEMBERS_MAP_MEMBER_WHERE,
        ...stateWhere,
        ...(onlineIds.length ? { id: { notIn: onlineIds } } : {}),
      },
      select: USER_LIST_SELECT,
      orderBy: [{ lastOnlineAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
      skip: offset,
      take: limit + 1,
    });

    const hasMore = rest.length > limit;
    const page = hasMore ? rest.slice(0, limit) : rest;
    const users = [...onlineUsers, ...page].map((u) => toUserListDto(u, this.publicBaseUrl));
    return { users, nextCursor: hasMore ? String(offset + limit) : null };
  }
}
