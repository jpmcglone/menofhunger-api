import { Inject } from '@nestjs/common';
import { PostsViewerEnrichmentService } from '../posts/posts-viewer-enrichment.service';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { ThreadRow, BoardListParams } from './board.constants';
import { BoardAccessService } from './board-access.service';
import { PostsReadService } from '../posts-read/posts-read.service';

import { PrismaService } from "../prisma/prisma.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { Prisma } from '@prisma/client';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { POST_LIST_INCLUDE } from '../../common/prisma-includes/post.include';
import { estimateReadingTimeMinutes } from '../../common/dto/article.dto';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { toBoardThreadDto, toPostDto, type BoardThreadDto } from '../../common/dto';
import { BOARD_MAX_TAGS, boardRangeStart, decodeOffsetCursor, encodeOffsetCursor, normalizeBoardTags } from './board.utils';
import type { BoardVisibility } from '../../common/dto';
import { NOT_DELETED } from '../../common/prisma/where';

const BOARD_VISIBILITIES: BoardVisibility[] = ['public', 'verifiedOnly', 'premiumOnly'];
import type { ViewerContext } from '../viewer/viewer-context.service';
import { toPage, clampLimit } from '../../common/pagination/page';

@Injectable()
export class BoardThreadsReadService {
  constructor(
    private readonly access: BoardAccessService,
    @Inject(PostsViewerEnrichmentService) private readonly postsEnrichment: Pick<PostsViewerEnrichmentService, 'viewerBoostedPostIds' | 'viewerBookmarksByPostId' | 'viewerLastSeenAtByPostId'>,
    private readonly postsRead: PostsReadService,
    private readonly prisma: PrismaService,
    private readonly viewerContext: ViewerContextService,
  ) {}

  async hydrateThreads(viewer: ViewerContext | null,
    rows: ThreadRow[],
  ): Promise<BoardThreadDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [boosted, bookmarks, lastSeen, hidden, unread] = await Promise.all([
      viewer
        ? this.postsEnrichment.viewerBoostedPostIds({
            viewerUserId: viewer.id,
            postIds: ids,
          })
        : Promise.resolve(new Set<string>()),
      viewer
        ? this.postsEnrichment.viewerBookmarksByPostId({
            viewerUserId: viewer.id,
            postIds: ids,
          })
        : Promise.resolve(new Map<string, { collectionIds: string[] }>()),
      viewer
        ? this.postsEnrichment.viewerLastSeenAtByPostId({
            openedOnly: true,
            viewerUserId: viewer.id,
            postIds: ids,
          })
        : Promise.resolve(new Map<string, Date>()),
      viewer
        ? this.prisma.boardHide.findMany({
            where: { userId: viewer.id, postId: { in: ids } },
            select: { postId: true },
          })
        : Promise.resolve([] as Array<{ postId: string }>),
      this.unreadActivity(viewer, ids),
    ]);
    const hiddenIds = new Set(hidden.map((h) => h.postId));
    const newCountById = await this.newCommentCounts(viewer, rows, lastSeen);
    const articleIds = rows
      .map((r) => r.articleId)
      .filter((id): id is string => Boolean(id));
    const readingTimeByArticleId = new Map(
      articleIds.length > 0
        ? (
            await this.prisma.article.findMany({
              where: { id: { in: articleIds } },
              select: { id: true, body: true },
            })
          ).map((a) => [a.id, estimateReadingTimeMinutes(a.body)] as const)
        : [],
    );

    return rows
      .filter((row) => row.boardThread)
      .map((row) => {
        const canAccess = this.access.canRead(viewer, row);
        const postDto = toPostDto(
          row,
          this.access.publicBaseUrl,
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
          viewerCanEdit: this.access.canEdit(viewer, row),
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
            publicBaseUrl: this.access.publicBaseUrl,
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
              ...NOT_DELETED,
            };
          }
        }
        return dto;
      });
  }

  async listThreads(params: BoardListParams,
  ): Promise<{ threads: BoardThreadDto[]; nextCursor: string | null }> {
    const viewer = await this.viewerContext.getViewer(params.viewerUserId);
    const limit = clampLimit(params.limit, { default: 50, max: 50 });
    const q = (params.q ?? "").trim().slice(0, 120);
    const tags = normalizeBoardTags(params.tags).slice(0, BOARD_MAX_TAGS);
    const authorUsername = (params.authorUsername ?? "").trim();

    const and: Prisma.PostWhereInput[] = [
      { kind: "board", parentId: null, deletedAt: null, isDraft: false },
      authorUsername
        ? {
            user: {
              ...NOT_BANNED_USER_WHERE,
              username: { equals: authorUsername, mode: "insensitive" },
            },
          }
        : { user: NOT_BANNED_USER_WHERE },
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
    const hiddenAuthors = await this.access.hiddenAuthorIds(viewer, {
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
            visibility: { in: this.access.readableVisibilities(viewer) },
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
          this.postsRead.findIncludingDeleted({
            where: { id },
            select: { id: true, createdAt: true },
          }),
      });
      rows = await this.postsRead.findMany({
        where: cursorWhere ? { AND: [where, cursorWhere] } : where,
        include: POST_LIST_INCLUDE,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      ({ items: rows, nextCursor } = toPage(rows, limit, (r) => r.id));
    } else {
      const offset = decodeOffsetCursor(params.cursor);
      const start = params.range ? boardRangeStart(params.range) : null;
      // Top matches the visible vote count. A range only filters creation time.
      rows = await this.postsRead.findMany({
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
      ({ items: rows, nextCursor } = toPage(rows, limit, () => encodeOffsetCursor(offset + limit)));
    }

    return { threads: await this.hydrateThreads(viewer, rows), nextCursor };
  }

  async getThread(
    viewerUserId: string | null,
    threadId: string,
  ): Promise<BoardThreadDto> {
    const viewer = await this.viewerContext.getViewer(viewerUserId);
    const row = await this.findThreadRow(threadId);
    const [dto] = await this.hydrateThreads(viewer, [row]);
    return dto!;
  }

  async findThreadRow(threadId: string): Promise<ThreadRow> {
    const id = (threadId ?? "").trim();
    const row = id
      ? await this.postsRead.findFirst({
          where: {
            id,
            kind: "board",
            parentId: null,
            ...NOT_DELETED,
            isDraft: false,
          },
          include: POST_LIST_INCLUDE,
        })
      : null;
    if (!row || !row.boardThread)
      throw new NotFoundException("Post not found.");
    return row;
  }

  /** Per thread: live comments by others (excluding hidden authors) newer than the viewer's last visit. */
  async newCommentCounts(
    viewer: ViewerContext | null,
    rows: ThreadRow[],
    lastSeen: Map<string, Date>,
  ): Promise<Map<string, number>> {
    const visited = viewer
      ? rows.filter((r) => lastSeen.has(r.id) && this.access.canRead(viewer, r))
      : [];
    if (!viewer || visited.length === 0) return new Map();
    const hiddenAuthors = await this.access.hiddenAuthorIds(viewer, {
      includeMuted: true,
    });
    const groups = await this.postsRead.commentCountsByRoot({
        ...NOT_DELETED,
        userId: { notIn: [viewer.id, ...hiddenAuthors] },
        OR: visited.map((r) => ({
          rootId: r.id,
          createdAt: { gt: lastSeen.get(r.id)! },
        })),
      });
    return new Map(
      groups.filter((g) => g.rootId).map((g) => [g.rootId!, g._count._all]),
    );
  }

  async unreadActivity(viewer: ViewerContext | null, ids: string[]) {
    const result = new Map<string, { kind: NonNullable<BoardThreadDto['unreadActivity']>; commentIds: Set<string> }>();
    if (!viewer) return result;
    const excludedActors = [viewer.id, ...await this.access.hiddenAuthorIds(viewer, { includeMuted: true })];
    const postScope = { kind: 'board' as const, OR: [{ id: { in: ids } }, { rootId: { in: ids } }] };
    const notifications = await this.prisma.notification.findMany({
      where: {
        recipientUserId: viewer.id, readAt: null,
        kind: { in: ['comment', 'mention', 'followed_post'] },
        OR: [{ actorPost: { is: postScope } }, { subjectPost: { is: postScope } }],
        NOT: { actorUserId: { in: excludedActors } },
      },
      distinct: ['kind', 'actorPostId', 'subjectPostId'],
      select: {
        kind: true,
        actorPost: { select: { id: true, rootId: true, parentId: true, kind: true } },
        subjectPost: { select: { id: true, rootId: true, parentId: true, kind: true } },
      },
    });
    const priority = { new: 0, comments: 1, reply: 2, mention: 3 };
    for (const notification of notifications) {
      const post = notification.actorPost?.kind === 'board' ? notification.actorPost : notification.subjectPost;
      if (!post) continue;
      const id = post.rootId ?? post.parentId ?? post.id;
      if (!ids.includes(id)) continue;
      const activity = notification.kind === 'mention' ? 'mention'
        : notification.kind === 'comment' && notification.subjectPost?.parentId ? 'reply'
        : post.parentId ? 'comments' : 'new';
      const entry = result.get(id) ?? { kind: activity, commentIds: new Set<string>() };
      if (priority[activity] > priority[entry.kind]) entry.kind = activity;
      if (post.parentId) entry.commentIds.add(post.id);
      result.set(id, entry);
    }
    return result;
  }
}
