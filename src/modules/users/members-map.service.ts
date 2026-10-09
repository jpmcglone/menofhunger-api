import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { toPage } from '../../common/pagination/page';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { toUserListDto, type UserListDto } from '../../common/dto';
import type { MembersMapStateDto, MembersMapSummaryDto } from '../../common/dto/members-map.dto';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { OnlineMembersService } from '../presence/online-members.service';
import { STATE_NAMES } from './users-location.service';

/**
 * Who counts as a member on the map: real, unbanned accounts. Bots are left out except Marv,
 * who is counted wherever he is shown online so his bucket's numbers stay consistent.
 */
export function membersMapMemberWhere(marvId: string | null): Prisma.UserWhereInput {
  // Same definition of "men" as the landing page: verified, unbanned person accounts.
  const man: Prisma.UserWhereInput = {
    isBot: false,
    isOrganization: false,
    accountKind: 'person',
    verifiedStatus: { not: 'none' },
  };
  return {
    usernameIsSet: true,
    ...NOT_BANNED_USER_WHERE,
    ...(marvId ? { OR: [man, { id: marvId }] } : man),
  };
}

export const MEMBERS_MAP_PREVIEW_SIZE = 6;
const ONLINE_FIRST_PAGE_MAX = 200;
const COUNTS_CACHE_TTL_MS = 10_000;

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
    private readonly redis: RedisService,
    private readonly onlineMembers: OnlineMembersService,
  ) {}

  private get publicBaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  /**
   * Verified viewers get faces and online ids; everyone else gets the same counts only,
   * served from a short shared cache because signed-out traffic can be heavy.
   */
  async summary(opts: { membersVisible: boolean; viewerUserId?: string | null; now?: Date }): Promise<MembersMapSummaryDto> {
    const now = opts.now ?? new Date();
    if (opts.membersVisible) return this.buildSummary(now, true, opts.viewerUserId ?? null);
    const key = RedisKeys.membersMapCounts();
    const cached = await this.redis.getJson<MembersMapSummaryDto>(key).catch(() => null);
    if (cached) return cached;
    const counts = await this.buildSummary(now, false, null);
    void this.redis.setJson(key, counts, { ttlMs: COUNTS_CACHE_TTL_MS }).catch(() => undefined);
    return counts;
  }

  private async buildSummary(now: Date, membersVisible: boolean, viewerUserId: string | null): Promise<MembersMapSummaryDto> {
    // Same roster as /presence/online and the realtime feed, so the online numbers always match.
    const roster = await this.onlineMembers.resolve({ viewerUserId, includeViewer: Boolean(viewerUserId) });
    const [groups, recentRows] = await Promise.all([
      this.prisma.user.groupBy({
        by: ['locationState'],
        where: membersMapMemberWhere(roster.marvId),
        _count: { _all: true },
      }),
      membersVisible ? this.recentPreviewRows() : Promise.resolve([]),
    ]);

    // Marv first, then most recently connected (the roster is oldest connection first).
    const onlineOrdered = [...(roster.marvId ? [roster.marvId] : []), ...[...roster.memberIds].reverse()];
    const onlineRows = onlineOrdered.map((id) => ({ id, locationState: roster.locationById.get(id) ?? null }));

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
      if (membersVisible) pushPreview(key, row.id);
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
      membersVisible,
      states,
      online: membersVisible ? onlineRows.map((r) => ({ userId: r.id, state: stateKey(r.locationState) })) : [],
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

  /** Up to six most recently active members per state (and the no-location bucket). */
  private recentPreviewRows() {
    return this.prisma.$queryRaw<Array<{ id: string; locationState: string | null }>>`
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
    `;
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

    const roster = await this.onlineMembers.resolve();
    const onlineIds = [...(roster.marvId ? [roster.marvId] : []), ...roster.memberIds];
    const memberWhere = membersMapMemberWhere(roster.marvId);

    const onlineUsers =
      offset === 0 && onlineIds.length
        ? await this.prisma.user.findMany({
            where: { AND: [memberWhere, stateWhere, { id: { in: onlineIds } }] },
            select: USER_LIST_SELECT,
            take: ONLINE_FIRST_PAGE_MAX,
          })
        : [];

    const rest = await this.prisma.user.findMany({
      where: { AND: [memberWhere, stateWhere, ...(onlineIds.length ? [{ id: { notIn: onlineIds } }] : [])] },
      select: USER_LIST_SELECT,
      orderBy: [{ lastOnlineAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
      skip: offset,
      take: limit + 1,
    });

    const { items: page, nextCursor } = toPage(rest, limit, () => String(offset + limit));
    const users = [...onlineUsers, ...page].map((u) => toUserListDto(u, this.publicBaseUrl));
    return { users, nextCursor };
  }
}
