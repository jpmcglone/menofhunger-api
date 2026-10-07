import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PostVisibility } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PostsService } from "../posts/posts.service";
import {
  ViewerContextService,
  type ViewerContext,
} from "../viewer/viewer-context.service";
import { AppConfigService } from "../app/app-config.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { MutesService } from "../mutes/mutes.service";
import {
  POST_BASE_INCLUDE,
  POST_LIST_INCLUDE,
} from "../../common/prisma-includes/post.include";
import { createdAtIdCursorWhere } from "../../common/pagination/created-at-id-cursor";
import { listBoardThreadsOn, hydrateBoardThreadsOn } from "./board-threads.query";
import { USER_LIST_SELECT } from "../../common/prisma-selects/user.select";
import {
  toBoardCommentDto,
  toPostDto,
  toUserListDto,
  type BoardCommentContextDto,
  type BoardCommentDto,
  type BoardCommentsPageDto,
  type BoardLeaderboardDto,
  type BoardLeaderboardUserDto,
  type BoardPreferencesDto,
  type BoardTagDto,
  type BoardThreadDto,
  type BoardVisibility,
  type PostWithAuthorAndMedia,
} from "../../common/dto";
import {
  BOARD_COMMENTS_MAX_ROWS,
  BOARD_DUPLICATE_WINDOW_DAYS,
  BOARD_MAX_TAGS,
  BOARD_SEED_TAGS,
  BOARD_TAG_MAX_LENGTH,
  BOARD_THREADS_PER_HOUR,
  BOARD_TITLE_MAX,
  BOARD_TITLE_MIN,
  normalizeBoardTags,
  normalizeBoardUrl,
  type BoardRange,
} from "./board.utils";

import { PostsReadService } from '../posts-read/posts-read.service';
import { PostsWriteService } from '../posts-read/posts-write.service';
import { slugifyBoardTag } from '../../common/text/slugify';
export type ThreadRow = Prisma.PostGetPayload<{ include: typeof POST_LIST_INCLUDE }>;
type CommentRow = Prisma.PostGetPayload<{ include: typeof POST_BASE_INCLUDE }>;

const EDIT_WINDOW_MS = 30 * 60 * 1000;
const MAX_EDITS = 3;
export const BOARD_VISIBILITIES: BoardVisibility[] = [
  "public",
  "verifiedOnly",
  "premiumOnly",
];

export type BoardListParams = {
  viewerUserId: string | null;
  sort: "top" | "new";
  range: BoardRange | null;
  visibility: "all" | BoardVisibility;
  tags: string[];
  domain: string | null;
  q: string | null;
  authorUsername: string | null;
  /** Only threads the viewer hid, so they can be brought back. */
  hiddenOnly?: boolean;
  limit: number;
  cursor: string | null;
};

export type BoardCreateThreadInput = {
  title: string;
  url: string | null;
  body: string | null;
  image: {
    r2Key: string;
    width: number | null;
    height: number | null;
    alt: string | null;
  } | null;
  tags: string[];
  visibility: BoardVisibility;
  showInFeed: boolean;
};

@Injectable()
export class BoardService implements OnModuleInit {
  constructor(
    readonly prisma: PrismaService,
    readonly posts: PostsService,
    readonly viewerContext: ViewerContextService,
    readonly appConfig: AppConfigService,
    readonly realtime: PresenceRealtimeService,
    readonly sideEffects: SideEffectsService,
    readonly mutes: MutesService,
    readonly postsRead: PostsReadService,
    readonly postsWrite: PostsWriteService,
  ) {}

  /** Authors kept off the viewer's Board lists: blocks in either direction, plus people the viewer muted. */
  async hiddenAuthorIds(
    viewer: ViewerContext | null,
    opts: { includeMuted: boolean },
  ): Promise<string[]> {
    if (!viewer) return [];
    const [blocks, muted] = await Promise.all([
      this.posts.viewerBlockSets(viewer.id),
      opts.includeMuted
        ? this.mutes.mutedIds(viewer.id)
        : Promise.resolve(new Set<string>()),
    ]);
    return [
      ...new Set([
        ...blocks.blockedByViewer,
        ...blocks.viewerBlockedBy,
        ...muted,
      ]),
    ];
  }

  /** One-shot: repair mirrored article comment counts; drop bodies that were auto-copied from the article excerpt. */
  async onModuleInit() {
    const threads = await this.postsRead.read.findMany({
      where: {
        kind: "board",
        articleId: { not: null },
        parentId: null,
        deletedAt: null,
      },
      select: { id: true, body: true, articleId: true },
    });
    if (!threads.length) return;
    await this.repairArticleBoardCommentCounts(threads.map((t) => t.id));

    const articleIds = [
      ...new Set(threads.map((t) => t.articleId!).filter(Boolean)),
    ];
    const articles = await this.prisma.article.findMany({
      where: { id: { in: articleIds } },
      select: { id: true, excerpt: true },
    });
    const excerptById = new Map(
      articles.map((a) => [a.id, (a.excerpt ?? "").trim().slice(0, 280)]),
    );
    const mirrored = threads.filter((t) => {
      const excerpt = excerptById.get(t.articleId!);
      const body = (t.body ?? "").trim();
      return Boolean(excerpt && body && body === excerpt);
    });
    if (mirrored.length) {
      await this.postsWrite.write.updateMany({
        where: { id: { in: mirrored.map((t) => t.id) } },
        data: { body: "" },
      });
    }
  }

  get publicBaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  canRead(
    viewer: ViewerContext | null,
    row: { userId: string; visibility: PostVisibility },
  ): boolean {
    if (row.visibility === "public") return true;
    if (!viewer) return false;
    if (viewer.siteAdmin || viewer.id === row.userId) return true;
    return this.viewerContext
      .allowedPostVisibilities(viewer)
      .includes(row.visibility);
  }

  readableVisibilities(viewer: ViewerContext | null): PostVisibility[] {
    if (viewer?.siteAdmin) return BOARD_VISIBILITIES;
    return this.viewerContext
      .allowedPostVisibilities(viewer)
      .filter((v) => v !== "onlyMe");
  }

  canEdit(
    viewer: ViewerContext | null,
    row: { userId: string; createdAt: Date; editCount: number },
  ): boolean {
    if (!viewer) return false;
    if (viewer.siteAdmin) return true;
    if (viewer.id !== row.userId) return false;
    return (
      Date.now() <= row.createdAt.getTime() + EDIT_WINDOW_MS &&
      row.editCount < MAX_EDITS
    );
  }

  // ─── Threads ────────────────────────────────────────────────────────────────

  async listThreads(
    params: BoardListParams,
  ): Promise<{ threads: BoardThreadDto[]; nextCursor: string | null }> {
    return listBoardThreadsOn(this, params);
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

  private async findThreadRow(threadId: string): Promise<ThreadRow> {
    const id = (threadId ?? "").trim();
    const row = id
      ? await this.postsRead.read.findFirst({
          where: {
            id,
            kind: "board",
            parentId: null,
            deletedAt: null,
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
      ? rows.filter((r) => lastSeen.has(r.id) && this.canRead(viewer, r))
      : [];
    if (!viewer || visited.length === 0) return new Map();
    const hiddenAuthors = await this.hiddenAuthorIds(viewer, {
      includeMuted: true,
    });
    const groups = await this.postsRead.read.groupBy({
      by: ["rootId"],
      where: {
        deletedAt: null,
        userId: { notIn: [viewer.id, ...hiddenAuthors] },
        OR: visited.map((r) => ({
          rootId: r.id,
          createdAt: { gt: lastSeen.get(r.id)! },
        })),
      },
      _count: { _all: true },
    });
    return new Map(
      groups.filter((g) => g.rootId).map((g) => [g.rootId!, g._count._all]),
    );
  }

  async unreadActivity(viewer: ViewerContext | null, ids: string[]) {
    const result = new Map<string, { kind: NonNullable<BoardThreadDto['unreadActivity']>; commentIds: Set<string> }>();
    if (!viewer) return result;
    const excludedActors = [viewer.id, ...await this.hiddenAuthorIds(viewer, { includeMuted: true })];
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

  async hydrateThreads(
    viewer: ViewerContext | null,
    rows: ThreadRow[],
  ): Promise<BoardThreadDto[]> {
    return hydrateBoardThreadsOn(this, viewer, rows);
  }

  async createThread(
    userId: string,
    input: BoardCreateThreadInput,
  ): Promise<BoardThreadDto> {
    const title = (input.title ?? "").trim().replace(/\s+/g, " ");
    if (title.length < BOARD_TITLE_MIN)
      throw new BadRequestException(
        `Titles need at least ${BOARD_TITLE_MIN} characters.`,
      );
    if (title.length > BOARD_TITLE_MAX)
      throw new BadRequestException(
        `Titles are limited to ${BOARD_TITLE_MAX} characters.`,
      );

    const rawUrl = (input.url ?? "").trim();
    const link = rawUrl ? normalizeBoardUrl(rawUrl) : null;
    if (rawUrl && !link)
      throw new BadRequestException("Enter a valid http or https link.");

    const tags = normalizeBoardTags(input.tags);
    if (tags.length > BOARD_MAX_TAGS)
      throw new BadRequestException(`Add up to ${BOARD_MAX_TAGS} tags.`);

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await this.postsRead.read.count({
      where: {
        userId,
        kind: "board",
        parentId: null,
        createdAt: { gte: since },
      },
    });
    if (recent >= BOARD_THREADS_PER_HOUR) {
      throw new HttpException(
        `You can start up to ${BOARD_THREADS_PER_HOUR} Board posts an hour.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const { post } = await this.posts.createPost({
      userId,
      body: (input.body ?? "").trim(),
      visibility: input.visibility,
      kind: "board",
      board: {
        title,
        url: link?.url ?? null,
        urlNormalized: link?.normalized ?? null,
        domain: link?.domain ?? null,
        tags,
        showInFeed: input.showInFeed,
      },
      media: input.image
        ? [
            {
              source: "upload",
              kind: "image",
              r2Key: input.image.r2Key,
              width: input.image.width ?? undefined,
              height: input.image.height ?? undefined,
              alt: input.image.alt,
            },
          ]
        : null,
      poll: null,
      mentions: null,
    });

    await Promise.all([
      this.bumpTags(tags),
      this.prisma.user.update({
        where: { id: userId },
        data: { boardShareToFeedDefault: input.showInFeed },
      }),
    ]);
    this.realtime.emitBoardNewThread({
      threadId: post.id,
      visibility: input.visibility,
      tags,
    });
    this.sideEffects.dispatch(
      "board.thread.tag",
      { threadId: post.id },
      { jobId: `board-tag-${post.id}` },
    );
    return this.getThread(userId, post.id);
  }

  /** Board thread created from an article publish. Title + article link only — body stays optional like other link posts. */
  async createArticleThread(params: {
    userId: string;
    article: {
      id: string;
      title: string;
      excerpt: string | null;
      visibility: PostVisibility;
      commentCount?: number;
    };
    tags: string[];
    showInFeed: boolean;
  }): Promise<string | null> {
    const existing = await this.postsRead.read.findFirst({
      where: {
        articleId: params.article.id,
        kind: "board",
        parentId: null,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (existing) return existing.id;

    const base = (
      this.appConfig.frontendBaseUrl() ?? "https://menofhunger.com"
    ).replace(/\/$/, "");
    const link = normalizeBoardUrl(`${base}/a/${params.article.id}`);
    const visibility = (
      params.article.visibility === "onlyMe"
        ? "verifiedOnly"
        : params.article.visibility
    ) as BoardVisibility;
    const tags = normalizeBoardTags(params.tags).slice(0, BOARD_MAX_TAGS);
    const { post } = await this.posts.createPost({
      userId: params.userId,
      body: "",
      visibility,
      kind: "board",
      articleId: params.article.id,
      board: {
        title: params.article.title.trim().slice(0, BOARD_TITLE_MAX),
        url: link?.url ?? null,
        urlNormalized: link?.normalized ?? null,
        domain: link?.domain ?? null,
        tags,
        showInFeed: params.showInFeed,
      },
      media: null,
      poll: null,
      mentions: null,
    });
    await this.bumpTags(tags);
    this.realtime.emitBoardNewThread({ threadId: post.id, visibility, tags });
    this.sideEffects.dispatch(
      "board.thread.tag",
      { threadId: post.id },
      { jobId: `board-tag-${post.id}` },
    );
    return post.id;
  }

  /** Keeps article-sourced threads aligned when the article changes. Board comment counts stay on the Board. */
  async syncArticleThread(
    articleId: string,
    patch: {
      title?: string;
      visibility?: PostVisibility;
      commentCount?: number;
      deleted?: boolean;
    },
  ) {
    const threads = await this.postsRead.read.findMany({
      where: { articleId, kind: "board", parentId: null, deletedAt: null },
      select: { id: true },
    });
    if (threads.length === 0) return;
    const ids = threads.map((t) => t.id);
    if (patch.deleted) {
      await this.postsWrite.write.updateMany({
        where: { id: { in: ids } },
        data: { deletedAt: new Date() },
      });
      for (const id of ids) {
        this.realtime.emitPostsLiveUpdated(id, {
          postId: id,
          version: new Date().toISOString(),
          reason: "post_deleted",
          patch: { deletedAt: new Date().toISOString() },
        });
      }
      return;
    }
    const postData: Prisma.PostUpdateManyMutationInput = {};
    if (patch.visibility && patch.visibility !== "onlyMe")
      postData.visibility = patch.visibility;
    if (Object.keys(postData).length)
      await this.postsWrite.write.updateMany({
        where: { id: { in: ids } },
        data: postData,
      });
    if (patch.title?.trim()) {
      await this.prisma.boardThread.updateMany({
        where: { postId: { in: ids } },
        data: { title: patch.title.trim().slice(0, BOARD_TITLE_MAX) },
      });
    }
    // Drop any previously mirrored article comment counts so the Board shows its own discussion.
    await this.repairArticleBoardCommentCounts(ids);
  }

  /** Set Board commentCount from live Board replies (not the article). */
  private async repairArticleBoardCommentCounts(
    threadIds: string[],
  ): Promise<void> {
    for (const id of threadIds) {
      const commentCount = await this.postsRead.read.count({
        where: { rootId: id, deletedAt: null, NOT: { id } },
      });
      await this.postsWrite.write.update({ where: { id }, data: { commentCount } });
    }
  }

  async updateThread(
    userId: string,
    threadId: string,
    input: {
      title?: string;
      url?: string | null;
      tags?: string[];
      body?: string;
    },
  ): Promise<BoardThreadDto> {
    const viewer = await this.viewerContext.getViewerOrThrow(userId);
    const row = await this.findThreadRow(threadId);
    if (row.userId !== userId && !viewer.siteAdmin)
      throw new ForbiddenException("Not allowed to edit this thread.");
    if (!this.canEdit(viewer, row))
      throw new ForbiddenException("This post can no longer be edited.");

    const data: Prisma.BoardThreadUpdateInput = {};
    if (typeof input.title === "string") {
      const title = input.title.trim().replace(/\s+/g, " ");
      if (title.length < BOARD_TITLE_MIN || title.length > BOARD_TITLE_MAX) {
        throw new BadRequestException(
          `Titles need ${BOARD_TITLE_MIN}–${BOARD_TITLE_MAX} characters.`,
        );
      }
      data.title = title;
    }
    if (input.url !== undefined && !row.articleId) {
      const raw = (input.url ?? "").trim();
      const link = raw ? normalizeBoardUrl(raw) : null;
      if (raw && !link)
        throw new BadRequestException("Enter a valid http or https link.");
      data.url = link?.url ?? null;
      data.urlNormalized = link?.normalized ?? null;
      data.domain = link?.domain ?? null;
    }
    if (Array.isArray(input.tags)) {
      const tags = normalizeBoardTags(input.tags);
      if (tags.length > BOARD_MAX_TAGS)
        throw new BadRequestException(`Add up to ${BOARD_MAX_TAGS} tags.`);
      const added = tags.filter((t) => !row.boardThread!.tags.includes(t));
      data.tags = tags;
      await this.bumpTags(added);
    }

    const nextBody = typeof input.body === "string" ? input.body.trim() : null;
    if (nextBody !== null && nextBody !== row.body) {
      await this.posts.updatePost({
        userId: row.userId,
        postId: row.id,
        body: nextBody,
        isSiteAdmin: viewer.siteAdmin,
      });
    } else if (Object.keys(data).length) {
      await this.postsWrite.write.update({
        where: { id: row.id },
        data: { editedAt: new Date(), editCount: { increment: 1 } },
      });
    }
    if (Object.keys(data).length) {
      await this.prisma.boardThread.update({ where: { postId: row.id }, data });
    }
    this.realtime.emitPostsLiveUpdated(row.id, {
      postId: row.id,
      version: new Date().toISOString(),
      reason: "post_edited",
      patch: {},
    });
    const contentChanged =
      typeof input.title === "string" ||
      input.url !== undefined ||
      (nextBody !== null && nextBody !== row.body);
    if (contentChanged && !Array.isArray(input.tags)) {
      this.sideEffects.dispatch("board.thread.tag", { threadId: row.id });
    }
    return this.getThread(userId, row.id);
  }

  async deletePost(userId: string, postId: string) {
    const row = await this.postsRead.read.findFirst({
      where: { id: postId, kind: "board" },
      select: { id: true },
    });
    if (!row) throw new NotFoundException("Not found.");
    return this.posts.deletePost({ userId, postId });
  }

  async setHidden(userId: string, threadId: string, hidden: boolean) {
    await this.findThreadRow(threadId);
    if (hidden) {
      await this.prisma.boardHide.upsert({
        where: { userId_postId: { userId, postId: threadId } },
        create: { userId, postId: threadId },
        update: {},
      });
    } else {
      await this.prisma.boardHide.deleteMany({
        where: { userId, postId: threadId },
      });
    }
    return { hidden };
  }

  // ─── Comments ───────────────────────────────────────────────────────────────

  async listComments(
    viewerUserId: string | null,
    threadId: string,
    sort: "top" | "new",
  ): Promise<BoardCommentsPageDto> {
    const viewer = await this.viewerContext.getViewer(viewerUserId);
    const root = await this.findThreadRow(threadId);
    if (!this.canRead(viewer, root))
      return { viewerCanAccess: false, comments: [] };
    const tree = await this.loadCommentTree(viewer, root.id, sort);
    return { viewerCanAccess: true, comments: tree.roots };
  }

  async getCommentContext(
    viewerUserId: string | null,
    commentId: string,
  ): Promise<BoardCommentContextDto> {
    const id = (commentId ?? "").trim();
    const row = id
      ? await this.postsRead.read.findFirst({
          where: { id, kind: "board", parentId: { not: null } },
          select: { id: true, rootId: true, parentId: true },
        })
      : null;
    if (!row) throw new NotFoundException("Comment not found.");
    const threadId = row.rootId ?? row.parentId!;
    const viewer = await this.viewerContext.getViewer(viewerUserId);
    const thread = await this.getThread(viewerUserId, threadId);
    if (!thread.viewerCanAccess)
      return { thread, ancestors: [], comment: null };

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

  private async loadCommentTree(
    viewer: ViewerContext | null,
    threadId: string,
    sort: "top" | "new",
  ) {
    const rows: CommentRow[] = await this.postsRead.read.findMany({
      where: { rootId: threadId, kind: "board" },
      include: POST_BASE_INCLUDE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: BOARD_COMMENTS_MAX_ROWS,
    });
    const boosted = viewer
      ? await this.posts.viewerBoostedPostIds({
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
        if (sort === "new")
          return b.createdAt.getTime() - a.createdAt.getTime();
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
          toPostDto(
            r as unknown as PostWithAuthorAndMedia,
            this.publicBaseUrl,
            { viewerHasBoosted: boosted.has(r.id) },
          ),
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

  async createComment(
    userId: string,
    threadId: string,
    input: { body: string; parentId: string | null },
  ): Promise<BoardCommentDto> {
    const root = await this.findThreadRow(threadId);
    const body = (input.body ?? "").trim();
    if (!body) throw new BadRequestException("Write a comment first.");
    let parentId = root.id;
    let depth = 0;
    if (input.parentId && input.parentId !== root.id) {
      const parent = await this.postsRead.read.findFirst({
        where: {
          id: input.parentId,
          rootId: root.id,
          kind: "board",
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!parent) throw new NotFoundException("Comment not found.");
      parentId = parent.id;
      depth = await this.depthOf(parent.id, root.id);
    }
    const { post } = await this.posts.createPost({
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
      toPostDto(post as unknown as PostWithAuthorAndMedia, this.publicBaseUrl, {
        viewerHasBoosted: false,
      }),
      { threadId: root.id, depth },
    );
  }

  private async depthOf(commentId: string, threadId: string): Promise<number> {
    let depth = 1;
    let current: string | null = commentId;
    for (let i = 0; i < 64 && current; i++) {
      const row: { parentId: string | null } | null =
        await this.postsRead.read.findUnique({
          where: { id: current },
          select: { parentId: true },
        });
      if (!row?.parentId || row.parentId === threadId) return depth;
      depth++;
      current = row.parentId;
    }
    return depth;
  }

  /** Newest comments across the Board (or by one member), limited to threads the viewer can read. */
  async listLatestComments(params: {
    viewerUserId: string | null;
    authorUsername: string | null;
    limit: number;
    cursor: string | null;
  }): Promise<{ comments: BoardCommentDto[]; nextCursor: string | null }> {
    const viewer = await this.viewerContext.getViewer(params.viewerUserId);
    const limit = Math.max(1, Math.min(50, params.limit));
    const authorUsername = (params.authorUsername ?? "").trim();
    const readable = this.readableVisibilities(viewer);
    const hiddenAuthors = await this.hiddenAuthorIds(viewer, {
      includeMuted: !authorUsername,
    });
    const where: Prisma.PostWhereInput = {
      kind: "board",
      parentId: { not: null },
      deletedAt: null,
      ...(hiddenAuthors.length ? { userId: { notIn: hiddenAuthors } } : {}),
      user: authorUsername
        ? {
            bannedAt: null,
            username: { equals: authorUsername, mode: "insensitive" },
          }
        : { bannedAt: null },
      OR: [
        { visibility: { in: readable } },
        ...(viewer ? [{ userId: viewer.id }] : []),
      ],
      root: { is: { deletedAt: null } },
    };
    const cursorWhere = await createdAtIdCursorWhere({
      cursor: params.cursor,
      lookup: (id) =>
        this.postsRead.read.findUnique({
          where: { id },
          select: { id: true, createdAt: true },
        }),
    });
    let rows = await this.postsRead.read.findMany({
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
    let nextCursor: string | null = null;
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      nextCursor = rows[rows.length - 1]?.id ?? null;
    }
    const boosted = viewer
      ? await this.posts.viewerBoostedPostIds({
          viewerUserId: viewer.id,
          postIds: rows.map((r) => r.id),
        })
      : new Set<string>();
    const comments = rows
      .filter((r) => r.root?.boardThread)
      .map((r) =>
        toBoardCommentDto(
          toPostDto(
            r as unknown as PostWithAuthorAndMedia,
            this.publicBaseUrl,
            { viewerHasBoosted: boosted.has(r.id) },
          ),
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

  // ─── Tags, duplicates, preferences ─────────────────────────────────────────

  private async bumpTags(tags: string[]) {
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

  async leaderboard(
    viewerUserId: string | null,
    limit: number,
  ): Promise<BoardLeaderboardDto> {
    const take = Math.max(1, Math.min(50, limit));
    const eligible = Prisma.sql`
      FROM "Post" p
      JOIN "User" u ON u.id = p."userId"
      WHERE p."kind" = 'board' AND p."deletedAt" IS NULL AND p."isDraft" = false
        AND u."bannedAt" IS NULL AND u."isBot" = false
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
        ? { ...toUserListDto(u, this.publicBaseUrl), boardPoints: points }
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

  async listTags(q: string | null, limit: number): Promise<BoardTagDto[]> {
    const prefix = slugifyBoardTag(q ?? "", BOARD_TAG_MAX_LENGTH) ?? "";
    const rows = await this.prisma.boardTag.findMany({
      where: prefix
        ? { slug: { startsWith: prefix } }
        : { threadCount: { gt: 0 } },
      orderBy: [{ threadCount: "desc" }, { slug: "asc" }],
      take: Math.max(1, Math.min(30, limit)),
      select: { slug: true, label: true, threadCount: true },
    });
    if (prefix) return rows;
    const seeded = BOARD_SEED_TAGS.filter(
      (s) => !rows.some((r) => r.slug === s),
    ).map((slug) => ({ slug, label: slug, threadCount: 0 }));
    return [...seeded, ...rows];
  }

  async findDuplicate(
    viewerUserId: string | null,
    rawUrl: string,
  ): Promise<BoardThreadDto | null> {
    const link = normalizeBoardUrl(rawUrl);
    if (!link) return null;
    const since = new Date(
      Date.now() - BOARD_DUPLICATE_WINDOW_DAYS * 86_400_000,
    );
    const row = await this.postsRead.read.findFirst({
      where: {
        kind: "board",
        parentId: null,
        deletedAt: null,
        createdAt: { gte: since },
        boardThread: { is: { urlNormalized: link.normalized } },
      },
      include: POST_LIST_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
    if (!row) return null;
    const viewer = await this.viewerContext.getViewer(viewerUserId);
    const [dto] = await this.hydrateThreads(viewer, [row]);
    return dto ?? null;
  }

  async getPreferences(userId: string): Promise<BoardPreferencesDto> {
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

  async updatePreferences(
    userId: string,
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
}
