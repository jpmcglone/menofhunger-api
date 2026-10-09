import { Injectable } from '@nestjs/common';
import { BoardAccessService } from './board-access.service';
import { BoardThreadsReadService } from './board-threads-read.service';
import { PostsReadService } from '../posts-read/posts-read.service';
import { PrismaService } from "../prisma/prisma.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { PUBLISHED_POST_SQL, RANKED_AUTHOR_SQL } from "../../common/sql/post-eligibility.sql";
import { clampLimit } from '../../common/pagination/page';
import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { POST_LIST_INCLUDE } from "../../common/prisma-includes/post.include";
import { USER_LIST_SELECT } from "../../common/prisma-selects/user.select";
import {
  toUserListDto,
  type BoardLeaderboardDto,
  type BoardLeaderboardUserDto,
  type BoardPreferencesDto,
  type BoardTagDto,
  type BoardThreadDto,
} from "../../common/dto";
import {
  BOARD_DUPLICATE_WINDOW_DAYS,
  BOARD_SEED_TAGS,
  BOARD_TAG_MAX_LENGTH,
  normalizeBoardUrl,
} from "./board.utils";
import { slugifyBoardTag } from "../../common/text/slugify";
import { NOT_DELETED } from '../../common/prisma/where';

@Injectable()
export class BoardInsightsService {
  constructor(
    private readonly threads: BoardThreadsReadService,
    private readonly access: BoardAccessService,
    private readonly postsRead: PostsReadService,
    private readonly prisma: PrismaService,
    private readonly viewerContext: ViewerContextService,
  ) {}

  async leaderboard(viewerUserId: string | null,
    limit: number,
  ): Promise<BoardLeaderboardDto> {
    const take = clampLimit(limit, { default: 50, max: 50 });
    const eligible = Prisma.sql`
      FROM "Post" p
      JOIN "User" u ON u.id = p."userId"
      WHERE p."kind" = 'board' AND ${PUBLISHED_POST_SQL} AND ${RANKED_AUTHOR_SQL}
    `;
    const top = await this.prisma.$queryRaw<
      Array<{ user_id: string; points: number }>
    >(Prisma.sql`
      SELECT p."userId" AS user_id, SUM(p."boostCount")::int AS points
      ${eligible}
      GROUP BY p."userId"
      HAVING SUM(p."boostCount") > 0
      ORDER BY points DESC, p."userId" ASC
      LIMIT ${take}
    `);

    let viewer: { rank: number; points: number } | null = null;
    if (viewerUserId && !top.some((r) => r.user_id === viewerUserId)) {
      const [mine] = await this.prisma.$queryRaw<
        Array<{ points: number }>
      >(Prisma.sql`
        SELECT COALESCE(SUM(p."boostCount"), 0)::int AS points ${eligible} AND p."userId" = ${viewerUserId}
      `);
      const points = mine?.points ?? 0;
      if (points > 0) {
        const [ahead] = await this.prisma.$queryRaw<
          Array<{ n: number }>
        >(Prisma.sql`
          SELECT COUNT(*)::int AS n FROM (
            SELECT p."userId" ${eligible} GROUP BY p."userId" HAVING SUM(p."boostCount") > ${points}
          ) ranked
        `);
        viewer = { rank: (ahead?.n ?? 0) + 1, points };
      }
    }

    const ids = [
      ...top.map((r) => r.user_id),
      ...(viewer && viewerUserId ? [viewerUserId] : []),
    ];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: USER_LIST_SELECT,
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const toRow = (
      id: string,
      points: number,
    ): BoardLeaderboardUserDto | null => {
      const u = byId.get(id);
      return u
        ? { ...toUserListDto(u, this.access.publicBaseUrl), boardPoints: points }
        : null;
    };
    const viewerRow =
      viewer && viewerUserId ? toRow(viewerUserId, viewer.points) : null;
    return {
      users: top
        .map((r) => toRow(r.user_id, r.points))
        .filter((r): r is BoardLeaderboardUserDto => Boolean(r)),
      viewerRank:
        viewer && viewerRow ? { rank: viewer.rank, user: viewerRow } : null,
      generatedAt: new Date().toISOString(),
    };
  }

  async listTags(q: string | null,
    limit: number,
  ): Promise<BoardTagDto[]> {
    const prefix = slugifyBoardTag(q ?? "", BOARD_TAG_MAX_LENGTH) ?? "";
    const rows = await this.prisma.boardTag.findMany({
      where: prefix
        ? { slug: { startsWith: prefix } }
        : { threadCount: { gt: 0 } },
      orderBy: [{ threadCount: "desc" }, { slug: "asc" }],
      take: clampLimit(limit, { default: 30, max: 30 }),
      select: { slug: true, label: true, threadCount: true },
    });
    if (prefix) return rows;
    const seeded = BOARD_SEED_TAGS.filter(
      (s) => !rows.some((r) => r.slug === s),
    ).map((slug) => ({ slug, label: slug, threadCount: 0 }));
    return [...seeded, ...rows];
  }

  async findDuplicate(viewerUserId: string | null,
    rawUrl: string,
  ): Promise<BoardThreadDto | null> {
    const link = normalizeBoardUrl(rawUrl);
    if (!link) return null;
    const since = new Date(Date.now() - BOARD_DUPLICATE_WINDOW_DAYS * 86_400_000);
    const row = await this.postsRead.findFirst({
      where: {
        kind: "board",
        parentId: null,
        ...NOT_DELETED,
        createdAt: { gte: since },
        boardThread: { is: { urlNormalized: link.normalized } },
      },
      include: POST_LIST_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
    if (!row) return null;
    const viewer = await this.viewerContext.getViewer(viewerUserId);
    const [dto] = await this.threads.hydrateThreads(viewer, [row]);
    return dto ?? null;
  }

  async getPreferences(userId: string,
  ): Promise<BoardPreferencesDto> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        boardShareToFeedDefault: true,
        articlePostToBoardDefault: true,
      },
    });
    if (!u) throw new NotFoundException("User not found.");
    return {
      shareToFeedDefault: u.boardShareToFeedDefault,
      articlePostToBoardDefault: u.articlePostToBoardDefault,
    };
  }

  async updatePreferences(userId: string,
    patch: Partial<BoardPreferencesDto>,
  ): Promise<BoardPreferencesDto> {
    const u = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(typeof patch.shareToFeedDefault === "boolean"
          ? { boardShareToFeedDefault: patch.shareToFeedDefault }
          : {}),
        ...(typeof patch.articlePostToBoardDefault === "boolean"
          ? { articlePostToBoardDefault: patch.articlePostToBoardDefault }
          : {}),
      },
      select: {
        boardShareToFeedDefault: true,
        articlePostToBoardDefault: true,
      },
    });
    return {
      shareToFeedDefault: u.boardShareToFeedDefault,
      articlePostToBoardDefault: u.articlePostToBoardDefault,
    };
  }

  async bumpTags(tags: string[]) {
    const now = new Date();
    await Promise.all(
      tags.map((slug) =>
        this.prisma.boardTag.upsert({
          where: { slug },
          create: { slug, label: slug, threadCount: 1, lastUsedAt: now },
          update: { threadCount: { increment: 1 }, lastUsedAt: now },
        }),
      ),
    );
  }
}





