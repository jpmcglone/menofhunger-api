import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { AppConfigService } from "../app/app-config.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { BoardService } from "../board/board.service";
import { ArticleAccessService } from "./article-access.service";
import { commentIncludes, articleR2BaseUrl } from "./articles.includes";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { parseMentionsFromBody } from "../../common/mentions/mention-regex";
import { assertPublishableText } from "../../common/moderation/content-filter";
import { toArticleCommentDto, type ArticleCommentWithAuthorAndReactions } from "../../common/dto/article.dto";
import { normalizeCommentBody } from "../../common/text/normalize";


@Injectable()
export class ArticleCommentWriterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewer: ViewerContextService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly sideEffects: SideEffectsService,
    private readonly board: BoardService,
    private readonly access: ArticleAccessService,
  ) {}

  async createArticleComment(
    userId: string,
    articleId: string,
    data: { body: string; parentId?: string | null },
  ) {
    const viewerCtx = await this.viewer.getViewerOrThrow(userId);
    if (
      !this.viewer.isVerified(viewerCtx) &&
      !this.viewer.isPremium(viewerCtx)
    ) {
      throw new ForbiddenException("Verified membership required to comment.");
    }

    const normalizedBody = normalizeCommentBody(data.body);
    assertPublishableText(normalizedBody);
    const maxCommentLength = this.viewer.isPremium(viewerCtx) ? 1000 : 500;
    if (normalizedBody.length > maxCommentLength) {
      throw new BadRequestException(
        `Comment must be ${maxCommentLength} characters or fewer.`,
      );
    }

    await this.access.assertAccessible(articleId, userId);

    if (data.parentId) {
      const parent = await this.prisma.articleComment.findUnique({
        where: { id: data.parentId },
      });
      if (!parent || parent.deletedAt)
        throw new NotFoundException("Parent comment not found.");
      if (parent.articleId !== articleId)
        throw new BadRequestException(
          "Parent comment belongs to a different article.",
        );
      if (parent.parentId !== null)
        throw new BadRequestException("Cannot reply more than one level deep.");
    }

    let newCommentCount: number | null = null;
    const comment = (await this.prisma.$transaction(async (tx) => {
      const c = await tx.articleComment.create({
        data: {
          articleId,
          authorId: userId,
          body: normalizedBody,
          parentId: data.parentId ?? null,
        },
        include: commentIncludes(),
      });
      if (data.parentId) {
        await tx.articleComment.update({
          where: { id: data.parentId },
          data: { replyCount: { increment: 1 } },
        });
      } else {
        const updated = await tx.article.update({
          where: { id: articleId },
          data: { commentCount: { increment: 1 } },
          select: { commentCount: true },
        });
        newCommentCount = updated.commentCount;
      }
      return c;
    })) as ArticleCommentWithAuthorAndReactions;

    const commentDto = toArticleCommentDto(
      comment,
      articleR2BaseUrl(this.appConfig),
      { viewerUserId: userId },
    );

    if (newCommentCount !== null) {
      this.presenceRealtime.emitArticlesLiveUpdated(articleId, {
        articleId,
        version: new Date().toISOString(),
        reason: "commentCount",
        patch: { commentCount: newCommentCount },
      });
    }

    this.presenceRealtime.emitArticlesCommentAdded(articleId, {
      articleId,
      comment: commentDto,
    });
    if (newCommentCount !== null) {
      void this.board
        .syncArticleThread(articleId, { commentCount: newCommentCount })
        .catch(() => undefined);
    }

    this.sideEffects.dispatch("article.comment.created", {
      articleId,
      commentId: comment.id,
      actorUserId: userId,
      parentCommentId: data.parentId ?? null,
      mentionUsernames: parseMentionsFromBody(commentDto.body ?? ""),
    });

    return commentDto;
  }
}
