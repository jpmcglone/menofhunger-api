import { Inject } from '@nestjs/common';
import { PostsViewerEnrichmentService } from '../posts/posts-viewer-enrichment.service';
import { PostsMutationWriteService } from '../posts/posts-mutation-write.service';
import { Injectable } from '@nestjs/common';
import { BoardAccessService } from './board-access.service';
import { BoardThreadsReadService } from './board-threads-read.service';
import { PostsReadService } from '../posts-read/posts-read.service';

import { ViewerContextService } from "../viewer/viewer-context.service";
import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { type ViewerContext } from "../viewer/viewer-context.service";
import { POST_BASE_INCLUDE } from "../../common/prisma-includes/post.include";
import { createdAtIdCursorWhere } from "../../common/pagination/created-at-id-cursor";
import { toBoardCommentDto, toPostDto, type BoardCommentContextDto, type BoardCommentDto, type BoardCommentsPageDto, type BoardVisibility } from "../../common/dto";
import { BOARD_COMMENTS_MAX_ROWS } from "./board.utils";
import { type CommentRow } from "./board.constants";
import { toPage, clampLimit } from "../../common/pagination/page";
import { NOT_DELETED } from '../../common/prisma/where';

@Injectable()
export class BoardCommentsService {
  constructor(
    private readonly threads: BoardThreadsReadService,
    private readonly access: BoardAccessService,
    @Inject(PostsViewerEnrichmentService) private readonly postsEnrichment: Pick<PostsViewerEnrichmentService, 'viewerBoostedPostIds'>,
    @Inject(PostsMutationWriteService) private readonly postsMutationWrite: Pick<PostsMutationWriteService, 'createPost'>,
    private readonly postsRead: PostsReadService,
    private readonly viewerContext: ViewerContextService,
  ) {}

  async listComments(viewerUserId: string | null,
    threadId: string,
    sort: "top" | "new",
  ): Promise<BoardCommentsPageDto> {
    const viewer = await this.viewerContext.getViewer(viewerUserId);
    const root = await this.threads.findThreadRow(threadId);
    if (!this.access.canRead(viewer, root))
      return { viewerCanAccess: false, comments: [] };
    const tree = await this.loadCommentTree(viewer, root.id, sort);
    return { viewerCanAccess: true, comments: tree.roots };
  }

  async getCommentContext(viewerUserId: string | null,
    commentId: string,
  ): Promise<BoardCommentContextDto> {
    const id = (commentId ?? "").trim();
    const row = id
      ? await this.postsRead.findFirst({
          where: { id, kind: "board", parentId: { not: null } },
          select: { id: true, rootId: true, parentId: true },
        })
      : null;
    if (!row) throw new NotFoundException("Comment not found.");
    const threadId = row.rootId ?? row.parentId!;
    const viewer = await this.viewerContext.getViewer(viewerUserId);
    const thread = await this.threads.getThread(viewerUserId, threadId);
    if (!thread.viewerCanAccess) return { thread, ancestors: [], comment: null };

    const tree = await this.loadCommentTree(viewer, threadId, "top");
    const node = tree.byId.get(id);
    if (!node) throw new NotFoundException("Comment not found.");
    const ancestors: BoardCommentDto[] = [];
    let parentId = node.parentId;
    while (parentId) {
      const parent = tree.byId.get(parentId);
      if (!parent) break;
      ancestors.unshift({ ...parent, replies: [] });
      parentId = parent.parentId;
    }
    return { thread, ancestors, comment: node };
  }

  async loadCommentTree(viewer: ViewerContext | null,
    threadId: string,
    sort: "top" | "new",
  ) {
    const rows: CommentRow[] = await this.postsRead.findMany({
      where: { rootId: threadId, kind: "board" },
      include: POST_BASE_INCLUDE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: BOARD_COMMENTS_MAX_ROWS,
    });
    const boosted = viewer
      ? await this.postsEnrichment.viewerBoostedPostIds({
          viewerUserId: viewer.id,
          postIds: rows.map((r) => r.id),
        })
      : new Set<string>();
    const childrenOf = new Map<string, CommentRow[]>();
    for (const r of rows) {
      const key = r.parentId ?? threadId;
      const list = childrenOf.get(key) ?? [];
      list.push(r);
      childrenOf.set(key, list);
    }
    const byId = new Map<string, BoardCommentDto>();
    const build = (parentId: string, depth: number): BoardCommentDto[] => {
      const kids = [...(childrenOf.get(parentId) ?? [])];
      kids.sort((a, b) => {
        if (sort === "new") return b.createdAt.getTime() - a.createdAt.getTime();
        return (
          b.boostCount - a.boostCount ||
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.id.localeCompare(a.id)
        );
      });
      const out: BoardCommentDto[] = [];
      for (const r of kids) {
        const replies = build(r.id, depth + 1);
        if (r.deletedAt && replies.length === 0) continue;
        const dto = toBoardCommentDto(
          toPostDto(r, this.access.publicBaseUrl, {
            viewerHasBoosted: boosted.has(r.id),
          }),
          { threadId, depth },
        );
        dto.replies = replies;
        byId.set(dto.id, dto);
        out.push(dto);
      }
      return out;
    };
    return { roots: build(threadId, 0), byId };
  }

  async createComment(userId: string,
    threadId: string,
    input: { body: string; parentId: string | null },
  ): Promise<BoardCommentDto> {
    const root = await this.threads.findThreadRow(threadId);
    const body = (input.body ?? "").trim();
    if (!body) throw new BadRequestException("Write a comment first.");
    let parentId = root.id;
    let depth = 0;
    if (input.parentId && input.parentId !== root.id) {
      const parent = await this.postsRead.findFirst({
        where: {
          id: input.parentId,
          rootId: root.id,
          kind: "board",
          ...NOT_DELETED,
        },
        select: { id: true },
      });
      if (!parent) throw new NotFoundException("Comment not found.");
      parentId = parent.id;
      depth = await this.depthOf(parent.id, root.id);
    }
    const { post } = await this.postsMutationWrite.createPost({
      userId,
      body,
      visibility: root.visibility,
      parentId,
      kind: "board",
      media: null,
      poll: null,
      mentions: null,
    });
    return toBoardCommentDto(
      toPostDto(post, this.access.publicBaseUrl, {
        viewerHasBoosted: false,
      }),
      { threadId: root.id, depth },
    );
  }

  async depthOf(commentId: string,
    threadId: string,
  ): Promise<number> {
    let depth = 1;
    let current: string | null = commentId;
    for (let i = 0; i < 64 && current; i++) {
      const row: { parentId: string | null } | null =
        await this.postsRead.findIncludingDeleted({
          where: { id: current },
          select: { parentId: true },
        });
      if (!row?.parentId || row.parentId === threadId) return depth;
      depth++;
      current = row.parentId;
    }
    return depth;
  }

  async listLatestComments(params: {
      viewerUserId: string | null;
      authorUsername: string | null;
      limit: number;
      cursor: string | null;
    },
  ): Promise<{ comments: BoardCommentDto[]; nextCursor: string | null }> {
    const viewer = await this.viewerContext.getViewer(params.viewerUserId);
    const limit = clampLimit(params.limit, { default: 50, max: 50 });
    const authorUsername = (params.authorUsername ?? "").trim();
    const readable = this.access.readableVisibilities(viewer);
    const hiddenAuthors = await this.access.hiddenAuthorIds(viewer, {
      includeMuted: !authorUsername,
    });
    const where: Prisma.PostWhereInput = {
      kind: "board",
      parentId: { not: null },
      ...NOT_DELETED,
      ...(hiddenAuthors.length ? { userId: { notIn: hiddenAuthors } } : {}),
      user: authorUsername
        ? {
            ...NOT_BANNED_USER_WHERE,
            username: { equals: authorUsername, mode: "insensitive" },
          }
        : NOT_BANNED_USER_WHERE,
      OR: [
        { visibility: { in: readable } },
        ...(viewer ? [{ userId: viewer.id }] : []),
      ],
      root: { is: NOT_DELETED },
    };
    const cursorWhere = await createdAtIdCursorWhere({
      cursor: params.cursor,
      lookup: (id) =>
        this.postsRead.findIncludingDeleted({
          where: { id },
          select: { id: true, createdAt: true },
        }),
    });
    let rows = await this.postsRead.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      include: {
        ...POST_BASE_INCLUDE,
        root: {
          select: {
            id: true,
            visibility: true,
            boardThread: { select: { title: true } },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    let nextCursor: string | null;
    ({ items: rows, nextCursor } = toPage(rows, limit, (r) => r.id));
    const boosted = viewer
      ? await this.postsEnrichment.viewerBoostedPostIds({
          viewerUserId: viewer.id,
          postIds: rows.map((r) => r.id),
        })
      : new Set<string>();
    const comments = rows
      .filter((r) => r.root?.boardThread)
      .map((r) =>
        toBoardCommentDto(
          toPostDto(r, this.access.publicBaseUrl, {
            viewerHasBoosted: boosted.has(r.id),
          }),
          {
            threadId: r.root!.id,
            depth: 0,
            thread: {
              id: r.root!.id,
              title: r.root!.boardThread!.title,
              visibility: r.root!.visibility as BoardVisibility,
            },
          },
        ),
      );
    return { comments, nextCursor };
  }
}






