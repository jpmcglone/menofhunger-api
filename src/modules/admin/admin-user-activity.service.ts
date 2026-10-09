import { Injectable } from "@nestjs/common";
import { createdAtIdCursorWhere } from "../../common/pagination/created-at-id-cursor";
import { toPage } from "../../common/pagination/page";
import { PostsReadService } from "../posts-read/posts-read.service";
import { PrismaService } from "../prisma/prisma.service";
import { recentListSchema, usernameParamSchema } from "./admin-users.constants";
import { findUserByUsernameOrThrow } from "./admin-users.lookup";
import { NOT_DELETED } from '../../common/prisma/where';

function normalizeSearchQueryForDedupe(query: string): string {
  return String(query ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Read-only recent activity lists (posts, articles, searches) for the admin user detail view. */
@Injectable()
export class AdminUserActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRead: PostsReadService,
  ) {}

  async recentPostsByUsername(params: unknown, query: unknown) {
    const { username } = usernameParamSchema.parse(params);
    const { limit, cursor } = recentListSchema.parse(query);
    const take = limit ?? 20;
    const user = await findUserByUsernameOrThrow(this.prisma, username);

    const cursorWhere = await createdAtIdCursorWhere({
      cursor: cursor ?? null,
      lookup: async (id) =>
        this.postsRead.findIncludingDeleted({
          where: { id },
          select: { id: true, createdAt: true, userId: true },
        }),
    });

    const rows = await this.postsRead.findMany({
      where: {
        userId: user.id,
        ...NOT_DELETED,
        ...(cursorWhere ?? {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      select: {
        id: true,
        createdAt: true,
        body: true,
        parentId: true,
        rootId: true,
        kind: true,
        visibility: true,
        commentCount: true,
        boostCount: true,
        bookmarkCount: true,
      },
    });

    const { items: slice, nextCursor } = toPage(rows, take, (r) => r.id);

    return {
      data: slice.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        body: row.body,
        parentId: row.parentId,
        rootId: row.rootId,
        kind: row.kind,
        visibility: row.visibility,
        commentCount: row.commentCount,
        boostCount: row.boostCount,
        bookmarkCount: row.bookmarkCount,
      })),
      pagination: { nextCursor },
    };
  }
  async recentArticlesByUsername(params: unknown, query: unknown) {
    const { username } = usernameParamSchema.parse(params);
    const { limit, cursor } = recentListSchema.parse(query);
    const take = limit ?? 20;
    const user = await findUserByUsernameOrThrow(this.prisma, username);

    const cursorWhere = await createdAtIdCursorWhere({
      cursor: cursor ?? null,
      lookup: async (id) =>
        this.prisma.article.findUnique({
          where: { id },
          select: {
            id: true,
            publishedAt: true,
            createdAt: true,
            authorId: true,
          },
        }),
    });

    const rows = await this.prisma.article.findMany({
      where: {
        authorId: user.id,
        ...NOT_DELETED,
        ...(cursorWhere ?? {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      select: {
        id: true,
        title: true,
        slug: true,
        excerpt: true,
        createdAt: true,
        publishedAt: true,
        isDraft: true,
        visibility: true,
        viewCount: true,
        totalViewCount: true,
        boostCount: true,
        commentCount: true,
      },
    });

    const { items: slice, nextCursor } = toPage(rows, take, (r) => r.id);

    return {
      data: slice.map((row) => ({
        id: row.id,
        title: row.title,
        slug: row.slug,
        excerpt: row.excerpt,
        createdAt: row.createdAt.toISOString(),
        publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
        isDraft: row.isDraft,
        visibility: row.visibility,
        viewCount: row.viewCount,
        totalViewCount: row.totalViewCount ?? row.viewCount,
        boostCount: row.boostCount,
        commentCount: row.commentCount,
      })),
      pagination: { nextCursor },
    };
  }
  async recentSearchesByUsername(params: unknown, query: unknown) {
    const { username } = usernameParamSchema.parse(params);
    const { limit, cursor } = recentListSchema.parse(query);
    const take = limit ?? 20;
    const user = await findUserByUsernameOrThrow(this.prisma, username);

    const cursorWhere = await createdAtIdCursorWhere({
      cursor: cursor ?? null,
      lookup: async (id) =>
        this.prisma.userSearch.findUnique({
          where: { id },
          select: { id: true, createdAt: true, userId: true },
        }),
    });

    const rows = await this.prisma.userSearch.findMany({
      where: {
        userId: user.id,
        // Exclude profile/group-tap entries — admin list is for typed queries only.
        targetUserId: null,
        targetGroupId: null,
        ...(cursorWhere ?? {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.max(take * 5, take + 1),
      select: {
        id: true,
        query: true,
        createdAt: true,
      },
    });

    const uniqueRows: Array<{ id: string; query: string; createdAt: Date }> =
      [];
    const seen = new Set<string>();
    for (const row of rows) {
      const key = normalizeSearchQueryForDedupe(row.query);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      uniqueRows.push(row);
      if (uniqueRows.length >= take + 1) break;
    }

    const { items: slice, nextCursor: pageCursor } = toPage(
      uniqueRows,
      take,
      (r) => r.id,
    );
    // Dedupe can shrink a full scan below a page; keep paging while the scan itself was full.
    const nextCursor =
      pageCursor ??
      (rows.length >= Math.max(take * 5, take + 1)
        ? (slice[slice.length - 1]?.id ?? null)
        : null);

    return {
      data: slice.map((row) => ({
        id: row.id,
        query: row.query,
        createdAt: row.createdAt.toISOString(),
      })),
      pagination: { nextCursor },
    };
  }
}
