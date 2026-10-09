import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { AppConfigService } from "../app/app-config.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { BoardService } from "../board/board.service";
import { ArticleAccessService } from "./article-access.service";
import { commentIncludes, commentLeafIncludes, articleR2BaseUrl } from "./articles.includes";
import { isUniqueViolation } from "../../common/prisma/errors";
import { assertPublishableText } from "../../common/moderation/content-filter";
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import {
  toArticleCommentDto,
  buildReactionSummaries,
  type ArticleCommentWithAuthorAndReactions,
} from "../../common/dto/article.dto";
import { findReactionById } from "../../common/constants/reactions";
import { toPage } from "../../common/pagination/page";
import { normalizeCommentBody } from "../../common/text/normalize";
import { assertOwnerOrAdmin } from "../../common/access/assert-owner-or-admin";
import { NOT_DELETED } from '../../common/prisma/where';

@Injectable()
export class ArticleCommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewer: ViewerContextService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly board: BoardService,
    private readonly access: ArticleAccessService,
  ) {}

  async listComments(opts: {
    articleId: string;
    viewerUserId?: string | null;
    limit?: number;
    cursor?: string | null;
  }) {
    await this.access.assertAccessible(opts.articleId, opts.viewerUserId);
    const limit = Math.min(opts.limit ?? 20, 50);

    const comments = (await this.prisma.articleComment.findMany({
      where: {
        articleId: opts.articleId,
        parentId: null,
        ...NOT_DELETED,
        ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      include: commentIncludes(),
    })) as ArticleCommentWithAuthorAndReactions[];

    const { items: items, nextCursor: nextCursor } = toPage(
      comments,
      limit,
      (r) => r.id,
    );
    return {
      comments: items.map((c) =>
        toArticleCommentDto(c, articleR2BaseUrl(this.appConfig), {
          viewerUserId: opts.viewerUserId,
        }),
      ),
      nextCursor,
    };
  }

  async getComment(opts: {
    articleId: string;
    commentId: string;
    viewerUserId?: string | null;
  }) {
    await this.access.assertAccessible(opts.articleId, opts.viewerUserId);
    const comment = (await this.prisma.articleComment.findFirst({
      where: { id: opts.commentId, articleId: opts.articleId, ...NOT_DELETED },
      include: commentLeafIncludes(),
    })) as ArticleCommentWithAuthorAndReactions | null;
    if (!comment) throw new NotFoundException("Reply not found.");

    const commentDto = toArticleCommentDto(
      comment,
      articleR2BaseUrl(this.appConfig),
      {
        viewerUserId: opts.viewerUserId,
      },
    );
    if (!comment.parentId) {
      return { comment: commentDto, parent: null };
    }

    const parent = (await this.prisma.articleComment.findFirst({
      where: { id: comment.parentId, articleId: opts.articleId },
      include: commentLeafIncludes(),
    })) as ArticleCommentWithAuthorAndReactions | null;
    if (!parent) {
      return { comment: commentDto, parent: null };
    }

    const parentWithReply = {
      ...parent,
      replies: [comment],
    } as ArticleCommentWithAuthorAndReactions;
    return {
      comment: commentDto,
      parent: toArticleCommentDto(
        parentWithReply,
        articleR2BaseUrl(this.appConfig),
        {
          viewerUserId: opts.viewerUserId,
        },
      ),
    };
  }

  async listCommentReplies(opts: {
    articleId: string;
    parentCommentId: string;
    viewerUserId?: string | null;
    limit?: number;
    cursor?: string | null;
  }) {
    await this.access.assertAccessible(opts.articleId, opts.viewerUserId);
    const parent = await this.prisma.articleComment.findUnique({
      where: { id: opts.parentCommentId },
      select: { id: true, articleId: true, parentId: true, deletedAt: true },
    });
    if (!parent || parent.deletedAt)
      throw new NotFoundException("Reply not found.");
    if (parent.articleId !== opts.articleId)
      throw new NotFoundException("Reply not found.");
    if (parent.parentId !== null)
      throw new BadRequestException(
        "Replies can only be loaded for top-level replies.",
      );

    const limit = Math.min(opts.limit ?? 20, 50);
    const replies = (await this.prisma.articleComment.findMany({
      where: {
        articleId: opts.articleId,
        parentId: opts.parentCommentId,
        ...NOT_DELETED,
        ...(opts.cursor ? { id: { gt: opts.cursor } } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      include: commentLeafIncludes(),
    })) as ArticleCommentWithAuthorAndReactions[];

    const { items: items, nextCursor: nextCursor } = toPage(
      replies,
      limit,
      (r) => r.id,
    );
    return {
      comments: items.map((c) =>
        toArticleCommentDto(c, articleR2BaseUrl(this.appConfig), {
          viewerUserId: opts.viewerUserId,
        }),
      ),
      nextCursor,
    };
  }

  async updateComment(userId: string, commentId: string, body: string) {
    const comment = await this.prisma.articleComment.findUnique({
      where: { id: commentId },
    });
    if (!comment || comment.deletedAt)
      throw new NotFoundException("Comment not found.");
    assertOwnerOrAdmin({ userId }, comment.authorId, "Not your comment.");

    const viewerCtx = await this.viewer.getViewerOrThrow(userId);
    const normalizedBody = normalizeCommentBody(body);
    assertPublishableText(normalizedBody);
    const maxCommentLength = this.viewer.isPremium(viewerCtx) ? 1000 : 500;
    if (normalizedBody.length > maxCommentLength) {
      throw new BadRequestException(
        `Comment must be ${maxCommentLength} characters or fewer.`,
      );
    }

    const updated = (await this.prisma.articleComment.update({
      where: { id: commentId },
      data: { body: normalizedBody, editedAt: new Date() },
      include: commentIncludes(),
    })) as ArticleCommentWithAuthorAndReactions;

    const updatedDto = toArticleCommentDto(
      updated,
      articleR2BaseUrl(this.appConfig),
      {
        viewerUserId: userId,
      },
    );
    this.presenceRealtime.emitArticlesCommentUpdated(comment.articleId, {
      articleId: comment.articleId,
      comment: updatedDto,
    });

    return updatedDto;
  }

  async deleteComment(userId: string, commentId: string) {
    const comment = await this.prisma.articleComment.findUnique({
      where: { id: commentId },
    });
    if (!comment || comment.deletedAt)
      throw new NotFoundException("Comment not found.");
    assertOwnerOrAdmin({ userId }, comment.authorId, "Not your comment.");

    let newCommentCount: number | null = null;
    await this.prisma.$transaction(async (tx) => {
      await tx.articleComment.update({
        where: { id: commentId },
        data: { deletedAt: new Date() },
      });
      if (comment.parentId) {
        await tx.articleComment.update({
          where: { id: comment.parentId },
          data: { replyCount: { decrement: 1 } },
        });
        const parentAfter = await tx.articleComment.findUnique({
          where: { id: comment.parentId },
          select: { replyCount: true },
        });
        if (parentAfter && parentAfter.replyCount < 0) {
          await tx.articleComment.update({
            where: { id: comment.parentId },
            data: { replyCount: 0 },
          });
        }
      } else {
        await tx.$executeRaw`UPDATE "Article" SET "commentCount" = GREATEST(0, "commentCount" - 1) WHERE "id" = ${comment.articleId}`;
        const after = await tx.article.findUnique({
          where: { id: comment.articleId },
          select: { commentCount: true },
        });
        newCommentCount = after?.commentCount ?? 0;
      }
    });

    this.presenceRealtime.emitArticlesCommentDeleted(comment.articleId, {
      articleId: comment.articleId,
      commentId,
      parentId: comment.parentId,
    });

    if (newCommentCount !== null) {
      this.presenceRealtime.emitArticlesLiveUpdated(comment.articleId, {
        articleId: comment.articleId,
        version: new Date().toISOString(),
        reason: "commentCount",
        patch: { commentCount: newCommentCount },
      });
      void this.board
        .syncArticleThread(comment.articleId, { commentCount: newCommentCount })
        .catch(() => undefined);
    }

    return { success: true };
  }

  async addCommentReaction(
    userId: string,
    commentId: string,
    reactionId: string,
  ) {
    const reaction = findReactionById(reactionId);
    if (!reaction) throw new BadRequestException("Invalid reaction.");
    const comment = await this.prisma.articleComment.findUnique({
      where: { id: commentId },
    });
    if (!comment || comment.deletedAt)
      throw new NotFoundException("Comment not found.");
    await this.access.assertAccessible(comment.articleId, userId);
    try {
      await this.prisma.articleCommentReaction.create({
        data: {
          commentId,
          userId,
          reactionId: reaction.id,
          emoji: reaction.emoji,
        },
      });
    } catch (e: any) {
      if (isUniqueViolation(e))
        throw new ConflictException("Already reacted with this emoji.");
      throw e;
    }

    await this.emitCommentReactionsChanged(comment, commentId, userId);

    return { reactionId: reaction.id, emoji: reaction.emoji };
  }

  async removeCommentReaction(
    userId: string,
    commentId: string,
    reactionId: string,
  ) {
    const existing = await this.prisma.articleCommentReaction.findUnique({
      where: { commentId_userId_reactionId: { commentId, userId, reactionId } },
    });
    if (!existing) throw new NotFoundException("Reaction not found.");

    const comment = await this.prisma.articleComment.findUnique({
      where: { id: commentId },
    });

    await this.prisma.articleCommentReaction.delete({
      where: { commentId_userId_reactionId: { commentId, userId, reactionId } },
    });

    if (comment) {
      await this.emitCommentReactionsChanged(comment, commentId, userId);
    }

    return { success: true };
  }

  async emitCommentReactionsChanged(
    comment: { articleId: string; parentId: string | null },
    commentId: string,
    viewerUserId: string,
  ): Promise<void> {
    try {
      const reactions = await this.prisma.articleCommentReaction.findMany({
        where: { commentId },
      });
      this.presenceRealtime.emitArticlesCommentReactionChanged(
        comment.articleId,
        {
          articleId: comment.articleId,
          commentId,
          parentId: comment.parentId,
          reactions: buildReactionSummaries(reactions, viewerUserId),
        },
      );
    } catch {
      // Best-effort
    }
  }
}
