import { Prisma } from '@prisma/client';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { POST_LIST_INCLUDE } from '../../common/prisma-includes/post.include';
import { estimateReadingTimeMinutes } from '../../common/dto/article.dto';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { toBoardThreadDto, toPostDto, type BoardThreadDto, type PostWithAuthorAndMedia } from '../../common/dto';
import { BOARD_MAX_TAGS, boardRangeStart, decodeOffsetCursor, encodeOffsetCursor, normalizeBoardTags } from './board.utils';
import type { BoardVisibility } from '../../common/dto';
import type { BoardListParams, BoardService, ThreadRow } from './board.service';

const BOARD_VISIBILITIES: BoardVisibility[] = ['public', 'verifiedOnly', 'premiumOnly'];
import type { ViewerContext } from '../viewer/viewer-context.service';

export async function hydrateBoardThreadsOn(host: BoardService, 
  viewer: ViewerContext | null,
  rows: ThreadRow[],
): Promise<BoardThreadDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [boosted, bookmarks, lastSeen, hidden, unread] = await Promise.all([
    viewer
      ? host.posts.viewerBoostedPostIds({
          viewerUserId: viewer.id,
          postIds: ids,
        })
      : Promise.resolve(new Set<string>()),
    viewer
      ? host.posts.viewerBookmarksByPostId({
          viewerUserId: viewer.id,
          postIds: ids,
        })
      : Promise.resolve(new Map<string, { collectionIds: string[] }>()),
    viewer
      ? host.posts.viewerLastSeenAtByPostId({
          openedOnly: true,
          viewerUserId: viewer.id,
          postIds: ids,
        })
      : Promise.resolve(new Map<string, Date>()),
    viewer
      ? host.prisma.boardHide.findMany({
          where: { userId: viewer.id, postId: { in: ids } },
          select: { postId: true },
        })
      : Promise.resolve([] as Array<{ postId: string }>),
    host.unreadActivity(viewer, ids),
  ]);
  const hiddenIds = new Set(hidden.map((h) => h.postId));
  const newCountById = await host.newCommentCounts(viewer, rows, lastSeen);
  const articleIds = rows
    .map((r) => r.articleId)
    .filter((id): id is string => Boolean(id));
  const readingTimeByArticleId = new Map(
    articleIds.length > 0
      ? (
          await host.prisma.article.findMany({
            where: { id: { in: articleIds } },
            select: { id: true, body: true },
          })
        ).map((a) => [a.id, estimateReadingTimeMinutes(a.body)] as const)
      : [],
  );

  return rows
    .filter((row) => row.boardThread)
    .map((row) => {
      const canAccess = host.canRead(viewer, row);
      const postDto = toPostDto(
        row as unknown as PostWithAuthorAndMedia,
        host.publicBaseUrl,
        {
          viewerHasBoosted: boosted.has(row.id),
          viewerHasBookmarked: bookmarks.has(row.id),
          viewerCanAccess: canAccess,
          ...(viewer ? { viewerHasViewed: lastSeen.has(row.id) } : {}),
        },
      );
      const dto = toBoardThreadDto(postDto, row.boardThread!, {
        viewerCanAccess: canAccess,
        viewerHidden: hiddenIds.has(row.id),
        viewerCanEdit: host.canEdit(viewer, row),
        articleId: row.articleId ?? null,
      });
      if (viewer) {
        dto.unreadActivity = canAccess ? unread.get(row.id)?.kind ?? null : null;
        dto.unreadCommentCount = canAccess ? unread.get(row.id)?.commentIds.size ?? 0 : 0;
        dto.viewerLastSeenAt = lastSeen.get(row.id)?.toISOString() ?? null;
        dto.newCommentCount =
          canAccess && lastSeen.has(row.id)
            ? (newCountById.get(row.id) ?? 0)
            : null;
      }
      const readingTime =
        canAccess && row.articleId
          ? readingTimeByArticleId.get(row.articleId)
          : undefined;
      if (readingTime) dto.readingTimeMinutes = readingTime;
      if (canAccess && !dto.image && row.article?.thumbnailR2Key) {
        const url = publicAssetUrl({
          publicBaseUrl: host.publicBaseUrl,
          key: row.article.thumbnailR2Key,
        });
        if (url) {
          dto.image = {
            id: `article-${row.article.id}`,
            kind: "image",
            source: "upload",
            url,
            mp4Url: null,
            thumbnailUrl: null,
            width: null,
            height: null,
            durationSeconds: null,
            alt: row.article.title,
            deletedAt: null,
          };
        }
      }
      return dto;
    });
}


export async function listBoardThreadsOn(host: BoardService, 
  params: BoardListParams,
): Promise<{ threads: BoardThreadDto[]; nextCursor: string | null }> {
  const viewer = await host.viewerContext.getViewer(params.viewerUserId);
  const limit = Math.max(1, Math.min(50, params.limit));
  const q = (params.q ?? "").trim().slice(0, 120);
  const tags = normalizeBoardTags(params.tags).slice(0, BOARD_MAX_TAGS);
  const authorUsername = (params.authorUsername ?? "").trim();

  const and: Prisma.PostWhereInput[] = [
    { kind: "board", parentId: null, deletedAt: null, isDraft: false },
    authorUsername
      ? {
          user: {
            bannedAt: null,
            username: { equals: authorUsername, mode: "insensitive" },
          },
        }
      : { user: { bannedAt: null } },
    {
      visibility:
        params.visibility === "all"
          ? { in: BOARD_VISIBILITIES }
          : params.visibility,
    },
  ];
  const threadWhere: Prisma.BoardThreadWhereInput = {
    ...(tags.length ? { tags: { hasSome: tags } } : {}),
    ...(params.domain
      ? {
          domain: params.domain
            .trim()
            .toLowerCase()
            .replace(/^www\./, ""),
        }
      : {}),
  };
  if (Object.keys(threadWhere).length)
    and.push({ boardThread: { is: threadWhere } });
  // The Board is site-wide: only visibility tier and the viewer's own hides shape the list, never follows.
  if (params.hiddenOnly) {
    if (!viewer) return { threads: [], nextCursor: null };
    and.push({ boardHides: { some: { userId: viewer.id } } });
  } else if (viewer && !authorUsername) {
    and.push({ boardHides: { none: { userId: viewer.id } } });
  }
  // A muted member's own Board tab still lists their posts; blocks hide them everywhere.
  const hiddenAuthors = await host.hiddenAuthorIds(viewer, {
    includeMuted: !authorUsername,
  });
  if (hiddenAuthors.length) and.push({ userId: { notIn: hiddenAuthors } });
  if (q) {
    and.push({
      OR: [
        {
          boardThread: {
            is: { title: { contains: q, mode: "insensitive" } },
          },
        },
        // Text matches only for threads the viewer can read, so search can't probe gated bodies.
        {
          body: { contains: q, mode: "insensitive" },
          visibility: { in: host.readableVisibilities(viewer) },
        },
      ],
    });
  }
  const where: Prisma.PostWhereInput = { AND: and };

  let rows: ThreadRow[];
  let nextCursor: string | null = null;

  if (params.sort === "new") {
    const cursorWhere = await createdAtIdCursorWhere({
      cursor: params.cursor,
      lookup: (id) =>
        host.postsRead.read.findUnique({
          where: { id },
          select: { id: true, createdAt: true },
        }),
    });
    rows = await host.postsRead.read.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      include: POST_LIST_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      nextCursor = rows[rows.length - 1]?.id ?? null;
    }
  } else {
    const offset = decodeOffsetCursor(params.cursor);
    const start = params.range ? boardRangeStart(params.range) : null;
    // Top matches the visible vote count. A range only filters creation time.
    rows = await host.postsRead.read.findMany({
      where: start ? { AND: [where, { createdAt: { gte: start } }] } : where,
      include: POST_LIST_INCLUDE,
      orderBy: [
        { boostCount: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      skip: offset,
      take: limit + 1,
    });
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      nextCursor = encodeOffsetCursor(offset + limit);
    }
  }

  return { threads: await hydrateBoardThreadsOn(host, viewer, rows), nextCursor };
}
