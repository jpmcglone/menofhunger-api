import { Inject } from '@nestjs/common';
import { PostsMutationWriteService } from '../posts/posts-mutation-write.service';
import { Injectable } from '@nestjs/common';
import { BoardInsightsService } from './board-insights.service';
import { AppConfigService } from "../app/app-config.service";
import { PostsReadService } from '../posts-read/posts-read.service';

import { PostsWriteService } from '../posts-read/posts-write.service';
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { PrismaService } from "../prisma/prisma.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import type { PostVisibility } from "@prisma/client";
import { type BoardVisibility } from "../../common/dto";
import {
  BOARD_MAX_TAGS,
  BOARD_TITLE_MAX,
  normalizeBoardTags,
  normalizeBoardUrl,
} from "./board.utils";
import { NOT_DELETED } from '../../common/prisma/where';

@Injectable()
export class BoardArticleThreadsService {
  constructor(
    private readonly insights: BoardInsightsService,
    private readonly appConfig: AppConfigService,
    @Inject(PostsMutationWriteService) private readonly postsMutationWrite: Pick<PostsMutationWriteService, 'createPost'>,
    private readonly postsRead: PostsReadService,
    private readonly postsWrite: PostsWriteService,
    private readonly prisma: PrismaService,
    private readonly realtime: PresenceRealtimeService,
    private readonly sideEffects: SideEffectsService,
  ) {}

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
    },
  ): Promise<string | null> {
    const existing = await this.postsRead.findFirst({
      where: {
        articleId: params.article.id,
        kind: "board",
        parentId: null,
        ...NOT_DELETED,
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
    const { post } = await this.postsMutationWrite.createPost({
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
    await this.insights.bumpTags(tags);
    this.realtime.emitBoardNewThread({ threadId: post.id, visibility, tags });
    this.sideEffects.dispatch(
      "board.thread.tag",
      { threadId: post.id },
      { jobId: `board-tag-${post.id}` },
    );
    return post.id;
  }

  async syncArticleThread(articleId: string,
    patch: {
      title?: string;
      visibility?: PostVisibility;
      commentCount?: number;
      deleted?: boolean;
    },
  ) {
    const threads = await this.postsRead.findMany({
      where: { articleId, kind: "board", parentId: null, ...NOT_DELETED },
      select: { id: true },
    });
    if (threads.length === 0) return;
    const ids = threads.map((t) => t.id);
    if (patch.deleted) {
      await this.postsWrite.deleteArticleBoardThreads(ids, new Date());
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
    if (patch.visibility && patch.visibility !== "onlyMe")
      await this.postsWrite.setArticleBoardVisibility(ids, patch.visibility);
    if (patch.title?.trim()) {
      await this.prisma.boardThread.updateMany({
        where: { postId: { in: ids } },
        data: { title: patch.title.trim().slice(0, BOARD_TITLE_MAX) },
      });
    }
    // Drop any previously mirrored article comment counts so the Board shows its own discussion.
    await this.repairArticleBoardCommentCounts(ids);
  }

  async repairArticleBoardCommentCounts(threadIds: string[],
  ): Promise<void> {
    for (const id of threadIds) {
      const commentCount = await this.postsRead.count({
        where: { rootId: id, ...NOT_DELETED, NOT: { id } },
      });
      await this.postsWrite.setBoardCommentCount(id, commentCount);
    }
  }
}



