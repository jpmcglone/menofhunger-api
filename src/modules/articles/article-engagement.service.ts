import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { PostsSharedWriteService } from "../posts/posts-shared-write.service";
import { ArticleAccessService } from "./article-access.service";
import { articleR2BaseUrl } from "./articles.includes";
import { isUniqueViolation } from "../../common/prisma/errors";
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import {
  toArticleSharePreviewDto,
  buildReactionSummaries,
  articleAuthorInclude,
  type ArticleWithAuthor,
} from "../../common/dto/article.dto";
import { toPostDto } from "../../common/dto/post.dto";
import { findReactionById } from "../../common/constants/reactions";
import type { PostVisibility } from "@prisma/client";

@Injectable()
export class ArticleEngagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly sideEffects: SideEffectsService,
    private readonly postsSharedWrite: PostsSharedWriteService,
    private readonly access: ArticleAccessService,
  ) {}

  async boost(userId: string, articleId: string) {
    await this.access.assertAccessible(articleId, userId);
    try {
      await this.prisma.$transaction([
        this.prisma.articleBoost.create({ data: { articleId, userId } }),
        this.prisma.article.update({
          where: { id: articleId },
          data: {
            boostCount: { increment: 1 },
            boostScore: null,
            boostScoreUpdatedAt: null,
          },
        }),
      ]);
    } catch (e: any) {
      if (isUniqueViolation(e)) throw new ConflictException("Already boosted.");
      throw e;
    }
    const afterBoost = await this.prisma.article.findUnique({
      where: { id: articleId },
      select: { boostCount: true },
    });
    if (afterBoost) {
      this.presenceRealtime.emitArticlesLiveUpdated(articleId, {
        articleId,
        version: new Date().toISOString(),
        reason: "boostCount",
        patch: { boostCount: afterBoost.boostCount },
      });
    }
    this.sideEffects.dispatch("article.boosted", {
      articleId,
      actorUserId: userId,
    });
    return { boosted: true };
  }

  async unboost(userId: string, articleId: string) {
    const boost = await this.prisma.articleBoost.findUnique({
      where: { articleId_userId: { articleId, userId } },
    });
    if (!boost) throw new NotFoundException("Boost not found.");
    await this.prisma.$transaction([
      this.prisma.articleBoost.delete({
        where: { articleId_userId: { articleId, userId } },
      }),
      this.prisma.article.update({
        where: { id: articleId },
        data: {
          boostCount: { decrement: 1 },
          boostScore: null,
          boostScoreUpdatedAt: null,
        },
      }),
    ]);
    const afterUnboost = await this.prisma.article.findUnique({
      where: { id: articleId },
      select: { boostCount: true },
    });
    if (afterUnboost) {
      this.presenceRealtime.emitArticlesLiveUpdated(articleId, {
        articleId,
        version: new Date().toISOString(),
        reason: "boostCount",
        patch: { boostCount: afterUnboost.boostCount },
      });
    }
    this.sideEffects.dispatch("article.unboosted", {
      articleId,
      actorUserId: userId,
    });
    return { boosted: false };
  }

  async addReaction(userId: string, articleId: string, reactionId: string) {
    const reaction = findReactionById(reactionId);
    if (!reaction) throw new BadRequestException("Invalid reaction.");
    await this.access.assertAccessible(articleId, userId);
    try {
      await this.prisma.articleReaction.create({
        data: {
          articleId,
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
    await this.emitArticleReactionsChanged(articleId, userId);
    this.sideEffects.dispatch("article.reaction.added", {
      articleId,
      actorUserId: userId,
      emoji: reaction.emoji,
    });
    return { reactionId: reaction.id, emoji: reaction.emoji };
  }

  async removeReaction(userId: string, articleId: string, reactionId: string) {
    const existing = await this.prisma.articleReaction.findUnique({
      where: { articleId_userId_reactionId: { articleId, userId, reactionId } },
    });
    if (!existing) throw new NotFoundException("Reaction not found.");
    await this.prisma.articleReaction.delete({
      where: { articleId_userId_reactionId: { articleId, userId, reactionId } },
    });
    await this.emitArticleReactionsChanged(articleId, userId);
    return { success: true };
  }

  async createSharePost(
    userId: string,
    articleId: string,
    body: string,
    shareVisibility?: PostVisibility,
  ) {
    const article = (await this.prisma.article.findUnique({
      where: { id: articleId },
      include: { author: { select: articleAuthorInclude } },
    })) as ArticleWithAuthor | null;

    if (!article || article.deletedAt)
      throw new NotFoundException("Article not found.");
    if (article.isDraft)
      throw new BadRequestException("Cannot share a draft article.");

    // Ensure sharer can see the article.
    await this.access.assertAccessible(articleId, userId);

    // Enforce visibility constraint: share visibility must be >= article visibility.
    const VISIBILITY_RANK: Record<PostVisibility, number> = {
      public: 0,
      verifiedOnly: 1,
      premiumOnly: 2,
      onlyMe: 3,
    };
    const articleRank = VISIBILITY_RANK[article.visibility] ?? 0;
    const effectiveVisibility = shareVisibility ?? article.visibility;
    const shareRank = VISIBILITY_RANK[effectiveVisibility] ?? 0;
    if (shareRank < articleRank) {
      throw new BadRequestException(
        `Share visibility must be at least as restrictive as the article's visibility (${article.visibility}).`,
      );
    }

    const post = await this.postsSharedWrite.createArticleShare({
      userId,
      body,
      visibility: effectiveVisibility,
      articleId: articleId,
    });

    const mappedPost = toPostDto(post, articleR2BaseUrl(this.appConfig));
    return {
      post: mappedPost,
      article: toArticleSharePreviewDto(
        article,
        articleR2BaseUrl(this.appConfig),
      ),
    };
  }

  async emitArticleReactionsChanged(
    articleId: string,
    viewerUserId: string,
  ): Promise<void> {
    try {
      const allReactions = await this.prisma.articleReaction.findMany({
        where: { articleId },
      });
      this.presenceRealtime.emitArticlesLiveUpdated(articleId, {
        articleId,
        version: new Date().toISOString(),
        reason: "reactions",
        patch: {
          reactions: buildReactionSummaries(allReactions, viewerUserId),
        },
      });
    } catch {
      // Best-effort
    }
  }
}
