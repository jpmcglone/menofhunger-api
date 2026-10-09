import { decodeJsonCursor, encodeJsonCursor } from '../../common/pagination/json-cursor';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FollowsService } from '../follows/follows.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { TickerService } from '../cashtags/ticker.service';
import type { CashtagResultDto } from '../../common/dto';
import { toCommunityGroupShellDto, type CommunityGroupShellDto } from '../../common/dto/community-group.dto';
import { PostsReadService } from '../posts-read/posts-read.service';
import { SearchUsersService } from './search-users.service';
import { queryToWords, type SearchArticleRow, type SearchUserRow } from './search.shared';
import { toPage, clampLimit } from '../../common/pagination/page';
import { findInviteBlockingCrewMemberIds } from '../viewer/crew-membership.queries';
import { listGroupMembershipsForUser } from '../viewer/group-membership.queries';
import { postSearchMatchWhere, articleSearchMatchWhere } from './search-where.builders';

import { SearchPostsService } from './search-posts.service';
import { SearchContentService } from './search-content.service';
import { NOT_DELETED } from '../../common/prisma/where';
export type { SearchArticleRow, SearchUserRow } from './search.shared';

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRead: PostsReadService,
    private readonly viewerContext: ViewerContextService,
    private readonly follows: FollowsService,
    private readonly ticker: TickerService,
    private readonly users: SearchUsersService,
    private readonly postsSearch: SearchPostsService,
    private readonly content: SearchContentService,
  ) {}

  /**
   * Users in a crew that blocks new invites. A solo crew member (memberCount === 1) stays
   * inviteable because accepting another crew's invite auto-disbands their old crew.
   */
  async inviteBlockingCrewMemberIds(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    return findInviteBlockingCrewMemberIds(this.prisma, userIds);
  }

  async searchUsers(params: {
    q: string;
    limit: number;
    cursor: string | null;
    viewerUserId: string | null;
  }): Promise<{ users: SearchUserRow[]; nextCursor: string | null }> {
    return this.users.searchUsers(params);
  }


  async searchHashtags(params: {
    q: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ hashtags: Array<{ value: string; label: string; usageCount: number }>; nextCursor: string | null }> {
    const raw = (params.q ?? '').trim();
    const limit = clampLimit(params.limit, { default: 30, max: 50 });

    const q = raw.startsWith('#') ? raw.slice(1) : raw;
    const qLower = q.toLowerCase();

    // Decode keyset cursor: base64-encoded JSON `{ usageCount: number; tag: string }`.
    let cursorUsageCount: number | null = null;
    let cursorTag: string | null = null;
    if (params.cursor) {
      const decoded = decodeJsonCursor(params.cursor);
      if (typeof decoded?.usageCount === 'number' && typeof decoded.tag === 'string') {
        cursorUsageCount = decoded.usageCount;
        cursorTag = decoded.tag;
      }
    }

    const cursorWhere: Prisma.HashtagWhereInput =
      cursorUsageCount !== null && cursorTag !== null
        ? {
            OR: [
              { usageCount: { lt: cursorUsageCount } },
              { AND: [{ usageCount: cursorUsageCount }, { tag: { gt: cursorTag } }] },
            ],
          }
        : {};

    const rows = await this.prisma.hashtag.findMany({
      where: qLower
        ? { AND: [{ tag: { startsWith: qLower } }, cursorWhere] }
        : cursorWhere,
      orderBy: [
        { usageCount: 'desc' },
        { tag: 'asc' },
      ],
      take: limit + 1,
      select: { tag: true, usageCount: true },
    });

    const tags = rows.map((r) => r.tag).filter(Boolean);
    const labelByTag = new Map<string, string>();
    if (tags.length > 0) {
      // Variants are the source of truth for display casing.
      // DISTINCT ON picks the highest-count variant per tag (ties -> variant asc).
      const variantRows = await this.prisma.$queryRaw<Array<{ tag: string; variant: string }>>(Prisma.sql`
        SELECT DISTINCT ON (hv."tag")
          hv."tag" as "tag",
          hv."variant" as "variant"
        FROM "HashtagVariant" hv
        WHERE hv."tag" IN (${Prisma.join(tags.map((t) => Prisma.sql`${t}`))})
        ORDER BY hv."tag" ASC, hv."count" DESC, hv."variant" ASC
      `);
      for (const r of variantRows) {
        const t = (r?.tag ?? '').trim();
        const v = (r?.variant ?? '').trim();
        if (t && v) labelByTag.set(t, v);
      }
    }

    const { items: slice, nextCursor } = toPage(rows, limit, (r) =>
      encodeJsonCursor({ usageCount: r.usageCount ?? 0, tag: r.tag }),
    );

    return {
      hashtags: slice.map((r) => ({
        value: r.tag,
        label: labelByTag.get(r.tag) ?? r.tag,
        usageCount: r.usageCount ?? 0,
      })),
      nextCursor,
    };
  }

  async searchCashtags(params: {
    q: string;
    limit: number;
  }): Promise<{ cashtags: CashtagResultDto[]; nextCursor: null }> {
    const raw = (params.q ?? '').trim();
    const q = raw.startsWith('$') ? raw.slice(1) : raw;
    const limit = clampLimit(params.limit, { default: 10, max: 50 });
    const cashtags = await this.ticker.searchPrefix(q, limit);
    return { cashtags, nextCursor: null };
  }

  async searchArticles(params: { viewerUserId: string | null; q: string; limit: number; cursor: string | null }) : Promise<{ articles: SearchArticleRow[]; nextCursor: string | null }> {
    return this.content.searchArticles(params);
  }

  async searchPosts(params: { viewerUserId: string | null; q: string; limit: number; cursor: string | null; kind?: 'regular' | 'checkin' | null }) {
    return this.postsSearch.searchPosts(params);
  }


  async searchCommunityGroups(params: {
    viewerUserId: string | null;
    q: string;
    limit: number;
  }): Promise<{ groups: CommunityGroupShellDto[] }> {
    const q = (params.q ?? '').trim();
    if (q.length < 2) return { groups: [] };
    const lim = Math.min(20, Math.max(1, params.limit));
    const needle = q.slice(0, 200);

    // Visibility: anonymous can only see open groups.
    // Authenticated users can see open groups OR groups they actively belong to.
    const visibilityWhere: Prisma.CommunityGroupWhereInput = params.viewerUserId
      ? {
          OR: [
            { joinPolicy: 'open' },
            { members: { some: { userId: params.viewerUserId, status: 'active' } } },
          ],
        }
      : { joinPolicy: 'open' };

    const rows = await this.prisma.communityGroup.findMany({
      where: {
        AND: [
          NOT_DELETED,
          visibilityWhere,
          {
            OR: [
              { name: { contains: needle, mode: 'insensitive' } },
              { slug: { contains: needle, mode: 'insensitive' } },
              { description: { contains: needle, mode: 'insensitive' } },
            ],
          },
        ],
      },
      orderBy: [{ memberCount: 'desc' }, { createdAt: 'desc' }],
      take: lim,
    });

    if (!rows.length) return { groups: [] };
    if (!params.viewerUserId) {
      return { groups: rows.map((g) => toCommunityGroupShellDto(g, null)) };
    }
    const memberships = await listGroupMembershipsForUser(this.prisma, params.viewerUserId, rows.map((r) => r.id));
    const byGroup = new Map(memberships.map((m) => [m.groupId, m] as const));
    return {
      groups: rows.map((g) => {
        const m = byGroup.get(g.id);
        const viewerMembership = m ? { status: m.status, role: m.role } : null;
        return toCommunityGroupShellDto(g, viewerMembership);
      }),
    };
  }

  async searchMixed(params: {
    viewerUserId: string | null;
    q: string;
    userLimit: number;
    postLimit: number;
    articleLimit: number;
    groupLimit: number;
    userCursor: string | null;
    postCursor: string | null;
    articleCursor: string | null;
    kind: 'regular' | 'checkin' | null;
  }): Promise<{
    users: SearchUserRow[];
    posts: Awaited<ReturnType<SearchService['searchPosts']>>['posts'];
    articles: SearchArticleRow[];
    groups: CommunityGroupShellDto[];
    nextUserCursor: string | null;
    nextPostCursor: string | null;
    nextArticleCursor: string | null;
    gatedResultCount: number;
  }> {
    const q = (params.q ?? '').trim();
    if (q.length < 2) {
      return {
        users: [],
        posts: [],
        articles: [],
        groups: [],
        nextUserCursor: null,
        nextPostCursor: null,
        nextArticleCursor: null,
        gatedResultCount: 0,
      };
    }

    const viewer = params.viewerUserId
      ? await this.viewerContext.getViewer(params.viewerUserId)
      : null;

    // Only compute gated count for anonymous or unverified users (the upsell audience).
    const shouldCountGated = !params.viewerUserId || (viewer && !this.viewerContext.isVerified(viewer));

    const [userResult, postResult, articleResult, groupResult] = await Promise.all([
      this.searchUsers({
        q,
        limit: params.userLimit,
        cursor: params.userCursor,
        viewerUserId: params.viewerUserId,
      }),
      this.searchPosts({
        viewerUserId: params.viewerUserId,
        q,
        limit: params.postLimit,
        cursor: params.postCursor,
        kind: params.kind ?? null,
      }),
      this.searchArticles({
        viewerUserId: params.viewerUserId,
        q,
        limit: params.articleLimit,
        cursor: params.articleCursor,
      }),
      this.searchCommunityGroups({
        viewerUserId: params.viewerUserId,
        q,
        limit: params.groupLimit,
      }),
    ]);

    // Count gated (verifiedOnly + premiumOnly) posts and articles excluded for anonymous/unverified viewers.
    // Cheap approximate count from the already-fetched article rows plus a dedicated post count.
    let gatedResultCount = 0;
    if (shouldCountGated && q.length >= 2) {
      const words = queryToWords(q);
      const matchWhere = articleSearchMatchWhere(q, words) as Prisma.ArticleWhereInput;
      const [gatedArticleCount, gatedPostCount] = await Promise.all([
        this.prisma.article.count({
          where: {
            AND: [
              { ...NOT_DELETED, isDraft: false, publishedAt: { not: null } },
              { visibility: { in: ['verifiedOnly', 'premiumOnly'] } },
              matchWhere,
            ],
          },
        }),
        this.postsRead.count({
          where: {
            AND: [
              NOT_DELETED,
              { visibility: { in: ['verifiedOnly', 'premiumOnly'] } },
              postSearchMatchWhere(q, words) as Prisma.PostWhereInput,
            ],
          },
        }),
      ]);
      gatedResultCount = gatedArticleCount + gatedPostCount;
    }

    return {
      users: userResult.users,
      posts: postResult.posts,
      articles: articleResult.articles,
      groups: groupResult.groups,
      nextUserCursor: userResult.nextCursor,
      nextPostCursor: postResult.nextCursor,
      nextArticleCursor: articleResult.nextCursor,
      gatedResultCount,
    };
  }

  /**
   * Store a user search for admin/analytics.
   * Called for typed queries (type=all) or for explicit user/group selections.
   * When a target (userId/groupId) is provided the dedupe key is the target rather than the query text.
   */
  async recordUserSearch(params: { userId: string; query: string; targetUserId?: string | null; targetGroupId?: string | null }) {
    const query = (params.query ?? '').trim().slice(0, 200);
    const targetUserId = params.targetUserId ?? null;
    const targetGroupId = params.targetGroupId ?? null;

    if (targetUserId) {
      // For profile taps: dedupe on the target within 30 min.
      const latest = await this.prisma.userSearch.findFirst({
        where: { userId: params.userId, targetUserId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { createdAt: true },
      });
      if (latest && Date.now() - latest.createdAt.getTime() < 1000 * 60 * 30) return;
      await this.prisma.userSearch.create({
        data: { userId: params.userId, query, targetUserId, targetGroupId: null },
      });
      return;
    }

    if (targetGroupId) {
      // For group taps: dedupe on the target within 30 min.
      const latest = await this.prisma.userSearch.findFirst({
        where: { userId: params.userId, targetGroupId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { createdAt: true },
      });
      if (latest && Date.now() - latest.createdAt.getTime() < 1000 * 60 * 30) return;
      await this.prisma.userSearch.create({
        data: { userId: params.userId, query, targetUserId: null, targetGroupId },
      });
      return;
    }

    if (!query) return;
    const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return;

    // Identical text within 30 min is one search. A shorter or longer prefix
    // is a different search when the client actually ran it.
    const latest = await this.prisma.userSearch.findFirst({
      where: { userId: params.userId, targetUserId: null, targetGroupId: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { query: true, createdAt: true },
    });
    if (latest) {
      const latestNormalized = String(latest.query ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      const ageMs = Date.now() - latest.createdAt.getTime();
      if (latestNormalized === normalized && ageMs < 1000 * 60 * 30) return;
    }

    await this.prisma.userSearch.create({
      data: { userId: params.userId, query, targetUserId: null, targetGroupId: null },
    });
  }

  async searchBookmarks(params: { viewerUserId: string | null; q: string; limit: number; cursor: string | null; collectionId: string | null; unorganized: boolean }) {
    return this.content.searchBookmarks(params);
  }
}

