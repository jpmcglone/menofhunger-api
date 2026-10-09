import { Inject } from '@nestjs/common';
import { PostsMutationWriteService } from '../posts/posts-mutation-write.service';
import { PostsMutationEditsService } from '../posts/posts-mutation-edits.service';
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PostVisibility } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

import { ViewerContextService } from "../viewer/viewer-context.service";
import { AppConfigService } from "../app/app-config.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { type BoardCommentContextDto, type BoardCommentDto, type BoardCommentsPageDto, type BoardLeaderboardDto, type BoardPreferencesDto, type BoardTagDto, type BoardThreadDto } from "../../common/dto";
import { BOARD_MAX_TAGS, BOARD_THREADS_PER_HOUR, BOARD_TITLE_MAX, BOARD_TITLE_MIN, normalizeBoardTags, normalizeBoardUrl } from "./board.utils";

import { PostsReadService } from '../posts-read/posts-read.service';
import { PostsWriteService } from '../posts-read/posts-write.service';
import { type BoardListParams, type BoardCreateThreadInput } from './board.constants';
import { BoardAccessService } from './board-access.service';
import { BoardThreadsReadService } from './board-threads-read.service';
import { BoardCommentsService } from './board-comments.service';
import { BoardArticleThreadsService } from './board-article-threads.service';
import { BoardInsightsService } from './board-insights.service';
import { NOT_DELETED } from '../../common/prisma/where';
export type { ThreadRow, BoardListParams, BoardCreateThreadInput } from './board.constants';

@Injectable()
export class BoardService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PostsMutationWriteService) private readonly postsMutationWrite: Pick<PostsMutationWriteService, 'createPost'>,
    @Inject(PostsMutationEditsService) private readonly postsMutationEdits: Pick<PostsMutationEditsService, 'updatePost' | 'deletePost'>,
    private readonly viewerContext: ViewerContextService,
    private readonly appConfig: AppConfigService,
    private readonly realtime: PresenceRealtimeService,
    private readonly sideEffects: SideEffectsService,
    private readonly postsRead: PostsReadService,
    private readonly postsWrite: PostsWriteService,
    private readonly access: BoardAccessService,
    private readonly threads: BoardThreadsReadService,
    private readonly comments: BoardCommentsService,
    private readonly articleThreads: BoardArticleThreadsService,
    private readonly insights: BoardInsightsService,
  ) {}

  /** One-shot: repair mirrored article comment counts; drop bodies that were auto-copied from the article excerpt. */
  async onModuleInit() {
    const threads = await this.postsRead.findMany({
      where: {
        kind: "board",
        articleId: { not: null },
        parentId: null,
        ...NOT_DELETED,
      },
      select: { id: true, body: true, articleId: true },
    });
    if (!threads.length) return;
    await this.articleThreads.repairArticleBoardCommentCounts(threads.map((t) => t.id));

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
      await this.postsWrite.clearArticleMirrorBodies(mirrored.map((t) => t.id));
    }
  }

  // ─── Threads ────────────────────────────────────────────────────────────────

  async getThread(viewerUserId: string | null, threadId: string): Promise<BoardThreadDto> {
    return this.threads.getThread(viewerUserId, threadId);
  }

  async listThreads(
    params: BoardListParams,
  ): Promise<{ threads: BoardThreadDto[]; nextCursor: string | null }> {
    return this.threads.listThreads(params);
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
    const recent = await this.postsRead.count({
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

    const { post } = await this.postsMutationWrite.createPost({
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
      this.insights.bumpTags(tags),
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
    return this.threads.getThread(userId, post.id);
  }

  async createArticleThread(params: { userId: string; article: { id: string; title: string; excerpt: string | null; visibility: PostVisibility; commentCount?: number }; tags: string[]; showInFeed: boolean }) : Promise<string | null> {
    return this.articleThreads.createArticleThread(params);
  }

  async syncArticleThread(articleId: string, patch: { title?: string; visibility?: PostVisibility; commentCount?: number; deleted?: boolean }) {
    return this.articleThreads.syncArticleThread(articleId, patch);
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
    const row = await this.threads.findThreadRow(threadId);
    if (row.userId !== userId && !viewer.siteAdmin)
      throw new ForbiddenException("Not allowed to edit this thread.");
    if (!this.access.canEdit(viewer, row))
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
      await this.insights.bumpTags(added);
    }

    const nextBody = typeof input.body === "string" ? input.body.trim() : null;
    if (nextBody !== null && nextBody !== row.body) {
      await this.postsMutationEdits.updatePost({
        userId: row.userId,
        postId: row.id,
        body: nextBody,
        isSiteAdmin: viewer.siteAdmin,
      });
    } else if (Object.keys(data).length) {
      await this.postsWrite.touchBoardThread(row.id);
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
    return this.threads.getThread(userId, row.id);
  }

  async deletePost(userId: string, postId: string) {
    const row = await this.postsRead.findFirst({
      where: { id: postId, kind: "board" },
      select: { id: true },
    });
    if (!row) throw new NotFoundException("Not found.");
    return this.postsMutationEdits.deletePost({ userId, postId });
  }

  async setHidden(userId: string, threadId: string, hidden: boolean) {
    await this.threads.findThreadRow(threadId);
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

  async listComments(viewerUserId: string | null, threadId: string, sort: "top" | "new") : Promise<BoardCommentsPageDto> {
    return this.comments.listComments(viewerUserId, threadId, sort);
  }

  async getCommentContext(viewerUserId: string | null, commentId: string) : Promise<BoardCommentContextDto> {
    return this.comments.getCommentContext(viewerUserId, commentId);
  }


  async createComment(userId: string, threadId: string, input: { body: string; parentId: string | null }) : Promise<BoardCommentDto> {
    return this.comments.createComment(userId, threadId, input);
  }


  async listLatestComments(params: { viewerUserId: string | null; authorUsername: string | null; limit: number; cursor: string | null }) : Promise<{ comments: BoardCommentDto[]; nextCursor: string | null }> {
    return this.comments.listLatestComments(params);
  }

  // ─── Tags, duplicates, preferences ─────────────────────────────────────────

  async leaderboard(viewerUserId: string | null, limit: number) : Promise<BoardLeaderboardDto> {
    return this.insights.leaderboard(viewerUserId, limit);
  }

  async listTags(q: string | null, limit: number) : Promise<BoardTagDto[]> {
    return this.insights.listTags(q, limit);
  }

  async findDuplicate(viewerUserId: string | null, rawUrl: string) : Promise<BoardThreadDto | null> {
    return this.insights.findDuplicate(viewerUserId, rawUrl);
  }

  async getPreferences(userId: string) : Promise<BoardPreferencesDto> {
    return this.insights.getPreferences(userId);
  }

  async updatePreferences(userId: string, patch: Partial<BoardPreferencesDto>) : Promise<BoardPreferencesDto> {
    return this.insights.updatePreferences(userId, patch);
  }
}
