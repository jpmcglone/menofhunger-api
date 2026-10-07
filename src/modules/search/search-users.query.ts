import { Prisma } from '@prisma/client';
import type { VerifiedStatus } from '@prisma/client';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import type { SearchService } from './search.service';
import {
  USER_SCORE,
  buildPrefixTsQuery,
  queryToWords,
  splitSearchQuery,
  type SearchUserRow,
} from './search.shared';

export async function searchUsersOn(host: SearchService, params: {
  q: string;
  limit: number;
  cursor: string | null;
  viewerUserId: string | null;
}): Promise<{ users: SearchUserRow[]; nextCursor: string | null }> {
  const { text: qText } = splitSearchQuery(params.q ?? '');
  // Strip leading @ so typing "@john" is equivalent to "john" (usernames don't include @).
  const q = (qText ?? '').trim().replace(/^@+/, '');
  if (!q) return { users: [], nextCursor: null };
  const limit = Math.max(1, Math.min(50, params.limit || 30));
  const cursor = params.cursor ?? null;
  const viewerUserId = params.viewerUserId ?? null;
  const qLower = q.toLowerCase();
  const words = queryToWords(q);

  // Exclude users that have a block relationship with the viewer (either direction).
  const blockedIds: Set<string> = viewerUserId
    ? await (async () => {
        const rows = await host.prisma.userBlock.findMany({
          where: { OR: [{ blockerId: viewerUserId }, { blockedId: viewerUserId }] },
          select: { blockerId: true, blockedId: true },
        });
        const s = new Set<string>();
        for (const r of rows) s.add(r.blockerId === viewerUserId ? r.blockedId : r.blockerId);
        return s;
      })()
    : new Set<string>();

  const fetchSize = Math.min(limit * 5, 50);
  type RawUser = {
    id: string;
    createdAt: Date;
    username: string | null;
    name: string | null;
    bio: string | null;
    premium: boolean;
    premiumPlus: boolean;
    isOrganization: boolean;
    accountKind?: 'person' | 'page';
    verifiedStatus: VerifiedStatus;
    avatarKey: string | null; avatarVideoKey?: string | null; avatarVideoDurationMs?: number | null;
    avatarUpdatedAt: Date | null;
    lastOnlineAt: Date | null;
  };

  let raw: RawUser[] = [];

  // FTS scales better than ILIKE but has two important caveats:
  //   1. websearch_to_tsquery drops single-char tokens ("g" in "Chris G") so initials never match.
  //   2. websearch_to_tsquery matches whole lexemes only — "grif" never matches "griffith".
  // We use to_tsquery with :* prefix operators instead, which fixes both problems.
  // Short words (< 2 chars) still fall back to ILIKE so "chris g" uses substring matching.
  const useFts = q.length >= 4 && words.length >= 2 && words.every((w) => w.length >= 2);
  const tsqString = useFts ? buildPrefixTsQuery(words) : null;

  if (tsqString) {
    const cursorRow =
      cursor
        ? await host.prisma.user.findUnique({ where: { id: cursor }, select: { id: true, createdAt: true } })
        : null;

    raw = await host.prisma.$queryRaw<RawUser[]>(Prisma.sql`
      WITH q AS (SELECT to_tsquery('english', ${tsqString}) AS tsq)
      SELECT
        u."id",
        u."createdAt",
        u."username",
        u."name",
        u."bio",
        u."premium",
        u."premiumPlus",
        u."isOrganization",
        u."accountKind",
        u."verifiedStatus",
        u."avatarKey", u."avatarVideoKey", u."avatarVideoDurationMs",
        u."avatarUpdatedAt",
        u."lastOnlineAt"
      FROM "User" u, q
      WHERE
        (u."usernameIsSet" = true OR u."name" IS NOT NULL)
        AND u."bannedAt" IS NULL
        ${
          blockedIds.size > 0
            ? Prisma.sql`AND u."id" NOT IN (${Prisma.join([...blockedIds].map((id) => Prisma.sql`${id}`))})`
            : Prisma.sql``
        }
        AND to_tsvector(
          'english',
          COALESCE(u."username", '') || ' ' || COALESCE(u."name", '') || ' ' || COALESCE(u."bio", '')
        ) @@ q.tsq
        ${
          cursorRow
            ? Prisma.sql`AND (
                u."createdAt" < ${cursorRow.createdAt}
                OR (u."createdAt" = ${cursorRow.createdAt} AND u."id" < ${cursorRow.id})
              )`
            : Prisma.sql``
        }
      ORDER BY u."createdAt" DESC, u."id" DESC
      LIMIT ${fetchSize + 1}
    `);
  } else {
    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await host.prisma.user.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    // Words that are long enough to be meaningful for substring matching.
    const meaningfulWords = words.filter((w) => w.length >= 2);

    const orConditions: any[] = [
      { username: { contains: q, mode: 'insensitive' as const } },
      { name: { contains: q, mode: 'insensitive' as const } },
      { bio: { not: null, contains: q, mode: 'insensitive' as const } },
    ];
    // Each individual word as its own condition (e.g. "chris" or "griffith" alone).
    for (const w of words) {
      if (w === qLower) continue;
      orConditions.push({ username: { contains: w, mode: 'insensitive' as const } });
      orConditions.push({ name: { contains: w, mode: 'insensitive' as const } });
      orConditions.push({ bio: { not: null, contains: w, mode: 'insensitive' as const } });
    }
    // All meaningful words must appear somewhere in name/username (word-order-independent).
    // This catches "Griffith Chris" matching "Chris Griffith" and similar reversed queries.
    if (meaningfulWords.length >= 2) {
      orConditions.push({
        AND: meaningfulWords.map((w) => ({ name: { contains: w, mode: 'insensitive' as const } })),
      });
      orConditions.push({
        AND: meaningfulWords.map((w) => ({ username: { contains: w, mode: 'insensitive' as const } })),
      });
    }
    const matchClause = { OR: orConditions };

    // For users without a set username, also match on name alone — including multi-word.
    const nameOnlyConditions: any[] = [{ name: { contains: q, mode: 'insensitive' as const } }];
    if (meaningfulWords.length >= 2) {
      nameOnlyConditions.push({
        AND: meaningfulWords.map((w) => ({ name: { contains: w, mode: 'insensitive' as const } })),
      });
    }
    const nameOnlyMatch: Prisma.UserWhereInput = {
      AND: [
        { name: { not: null } },
        { OR: nameOnlyConditions },
      ],
    };

    const blockExclude: Prisma.UserWhereInput =
      blockedIds.size > 0 ? { id: { notIn: [...blockedIds] } } : {};

    const whereWithCursor: Prisma.UserWhereInput = cursorWhere
      ? {
          AND: [
            cursorWhere,
            { bannedAt: null },
            blockExclude,
            {
              OR: [
                { usernameIsSet: true, ...matchClause },
                nameOnlyMatch,
              ],
            },
          ],
        }
      : {
          AND: [
            { bannedAt: null },
            blockExclude,
            {
              OR: [
                { usernameIsSet: true, ...matchClause },
                nameOnlyMatch,
              ],
            },
          ],
        };

    raw = await host.prisma.user.findMany({
      where: whereWithCursor,
      select: {
        id: true,
        createdAt: true,
        username: true,
        name: true,
        bio: true,
        premium: true,
        premiumPlus: true,
        isOrganization: true,
        accountKind: true,
        verifiedStatus: true,
        avatarKey: true, avatarVideoKey: true, avatarVideoDurationMs: true,
        avatarUpdatedAt: true,
        lastOnlineAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: fetchSize + 1,
    });
  }

  const userIds = raw.map((u) => u.id);
  const [rel, orgMembershipRows] = await Promise.all([
    host.follows.batchRelationshipForUserIds({ viewerUserId, userIds }),
    userIds.length > 0
      ? host.prisma.userOrgMembership.findMany({
          where: { userId: { in: userIds } },
          select: {
            userId: true,
            org: { select: { id: true, username: true, name: true, avatarKey: true, avatarVideoKey: true, avatarVideoDurationMs: true, avatarUpdatedAt: true } },
          },
          orderBy: { createdAt: 'asc' },
        })
      : Promise.resolve([]),
  ]);
  type OrgMembershipRow = (typeof orgMembershipRows)[number];
  const orgsByUserId = new Map<string, OrgMembershipRow[]>();
  for (const row of orgMembershipRows) {
    if (!orgsByUserId.has(row.userId)) orgsByUserId.set(row.userId, []);
    orgsByUserId.get(row.userId)!.push(row);
  }

  function userScore(u: (typeof raw)[0]): number {
    const un = (u.username ?? '').trim().toLowerCase();
    const nm = (u.name ?? '').trim().toLowerCase();
    const bio = (u.bio ?? '').trim().toLowerCase();

    // Decimal sub-sort within each tier: how much of the matched field the query "covers".
    // Keeps tiers intact (integer part) while surfacing closer matches first.
    // e.g. typing "joe" — "joe_s" scores 85.79, "joe_black12345" scores 85.21.
    const ratio = (fieldLen: number) =>
      fieldLen > 0 ? Math.min(qLower.length / fieldLen, 1) * 0.99 : 0;

    if (un === qLower) return USER_SCORE.exactUsername;
    if (nm === qLower) return USER_SCORE.exactName;
    if (un && un.startsWith(qLower)) return USER_SCORE.usernameStartsWith + ratio(un.length);

    // Multi-word: all query words (≥ 2 chars) appear anywhere in name/username.
    // Beats nameStartsWith because it's word-order-independent and more specific for
    // queries like "Chris Griffith" or "Griffith Chris".
    const mw = words.filter((w) => w.length >= 2);
    if (mw.length >= 2 && nm && mw.every((w) => nm.includes(w))) return USER_SCORE.nameAllWords + ratio(nm.length);
    if (mw.length >= 2 && un && mw.every((w) => un.includes(w))) return USER_SCORE.usernameAllWords + ratio(un.length);

    if (nm && nm.startsWith(qLower)) return USER_SCORE.nameStartsWith + ratio(nm.length);
    if (un && un.includes(qLower)) return USER_SCORE.usernameContains + ratio(un.length);

    // Multi-word: each query word is a prefix of at least one word in the display name.
    // Handles "ch gr" → "Chris Griffith", "jo sm" → "John Smith".
    if (mw.length >= 2 && nm) {
      const nmTokens = nm.split(/\s+/).filter(Boolean);
      if (mw.every((qw) => nmTokens.some((nw) => nw.startsWith(qw)))) {
        return USER_SCORE.nameWordPrefixes + ratio(nm.length);
      }
    }

    if (nm && nm.includes(qLower)) return USER_SCORE.nameContains + ratio(nm.length);
    if (bio && bio.includes(qLower)) return USER_SCORE.bioPhrase + ratio(bio.length);
    if (words.length > 0 && words.every((w) => bio.includes(w))) return USER_SCORE.bioAllWords;
    if (words.some((w) => bio.includes(w))) return USER_SCORE.bioAnyWord;
    return 0;
  }
  // Relationship rank: mutuals first, then people who follow you, then people you follow, then strangers.
  const relRank = (id: string) => {
    const vf = rel.viewerFollows.has(id);
    const fv = rel.followsViewer.has(id);
    if (vf && fv) return 0; // mutual
    if (fv) return 1;       // follows you (but you don't follow them)
    if (vf) return 2;       // you follow them (but they don't follow you)
    return 3;               // no relationship
  };

  // Within each rel group, sort by most recently online (nulls last).
  const onlineMs = (u: (typeof raw)[0]) => u.lastOnlineAt?.getTime() ?? 0;

  const sorted = [...raw].sort((a, b) => {
    const sa = userScore(a);
    const sb = userScore(b);
    if (sa !== sb) return sb - sa;
    const ra = relRank(a.id);
    const rb = relRank(b.id);
    if (ra !== rb) return ra - rb;
    const oa = onlineMs(a);
    const ob = onlineMs(b);
    if (oa !== ob) return ob - oa;
    return b.id.localeCompare(a.id);
  });

  const slice = sorted.slice(0, limit);
  const nextCursor = raw.length > fetchSize ? raw[fetchSize]?.id ?? null : null;

  const users: SearchUserRow[] = slice.map((u) => ({
    id: u.id,
    createdAt: u.createdAt,
    username: u.username,
    name: u.name,
    premium: u.premium,
    premiumPlus: u.premiumPlus,
    isOrganization: Boolean(u.isOrganization),
    accountKind: u.accountKind ?? 'person',
    verifiedStatus: u.verifiedStatus,
    avatarKey: u.avatarKey, avatarVideoKey: u.avatarVideoKey, avatarVideoDurationMs: u.avatarVideoDurationMs,
    avatarUpdatedAt: u.avatarUpdatedAt,
    orgMemberships: orgsByUserId.get(u.id) ?? [],
    relationship: {
      viewerFollowsUser: rel.viewerFollows.has(u.id),
      userFollowsViewer: rel.followsViewer.has(u.id),
      viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(u.id),
      viewerNotificationPreference: rel.viewerNotificationPreferences?.get(u.id) ?? 'off',
    },
  }));

  return { users, nextCursor };
}
