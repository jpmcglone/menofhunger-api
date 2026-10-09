import { xArticleContent } from "./x-article-content";
import { X_REFERENCE_PRICES } from "./integration-budget.policy";
import { OutboundService } from "../outbound/outbound.service";
import { Injectable } from "@nestjs/common";
import type { CrosspostMode, PickaxCrosspostKind } from "@prisma/client";
import { xPostBlocker, xWeightedLength, linkBlocker, xBlockerMessage, xPostCostMicros } from "../../common/crosspost/crosspost-eligibility";
import { AppConfigService } from "../app/app-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { XConnectionService, monthStartUtc } from "./x-connection.service";

import { PostsReadService } from "../posts-read/posts-read.service";
import { type XQueueResult, type LoadedPost, xArticleLinkText, xBoardLinkText } from './x-crosspost.constants';
import { XCrosspostOutcomeService } from './x-crosspost-outcome.service';
import { XCrosspostPublishService } from './x-crosspost-publish';
import { XArticleSyncService } from './x-crosspost-article-sync';
export type { XQueueResult } from './x-crosspost.constants';

@Injectable()
export class XCrosspostService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: OutboundService,
    private readonly appConfig: AppConfigService,
    private readonly connections: XConnectionService,
    private readonly postsRead: PostsReadService,
    private readonly outcome: XCrosspostOutcomeService,
    private readonly publisher: XCrosspostPublishService,
    private readonly articleSync: XArticleSyncService,
  ) {}

  async requestPostCrosspost(
    userId: string,
    postId: string,
    requested: CrosspostMode,
  ): Promise<XQueueResult> {
    const post = await this.loadPost(postId);
    if (!post || post.userId !== userId)
      return { status: "skipped", reason: "not_found" };
    if (post.kind === "board") {
      const reason = linkBlocker(post);
      if (reason) return { status: "skipped", reason };
      if (!this.appConfig.integrationBudget().enabled)
        return { status: "skipped", reason: "pricing_unconfirmed" };
      if (xWeightedLength(xBoardLinkText(this.appConfig.frontendBaseUrl(), postId, post.boardTitle)) > 280)
        return { status: "skipped", reason: "too_long" };
      return this.reserveAndQueue({
        userId,
        kind: "post",
        localId: postId,
        mode: "link",
        costMicros: X_REFERENCE_PRICES.createWithUrl,
        job: "x.post.sync",
      });
    }
    const reason = xPostBlocker(
      post,
      requested,
      this.appConfig.integrationBudget().enabled,
    );
    if (reason) return { status: "skipped", reason };
    const text = post.body.trim();
    return this.reserveAndQueue({
      userId,
      kind: "post",
      localId: postId,
      mode: "native",
      costMicros: xPostCostMicros(text),
      job: "x.post.sync",
    });
  }

  async requestArticleCrosspost(
    userId: string,
    articleId: string,
    mode: CrosspostMode = "native",
  ): Promise<XQueueResult> {
    const article = await this.prisma.article.findUnique({
      where: { id: articleId },
    });
    if (!article || article.authorId !== userId)
      return { status: "skipped", reason: "not_found" };
    if (article.deletedAt || article.isDraft || !article.publishedAt)
      return { status: "skipped", reason: "not_published" };
    if (article.visibility !== "public")
      return { status: "skipped", reason: "not_public" };
    if (!this.appConfig.integrationBudget().enabled)
      return { status: "skipped", reason: "pricing_unconfirmed" };
    if (mode === "link") {
      const text = xArticleLinkText(this.appConfig.frontendBaseUrl(), articleId, article.title);
      if (xWeightedLength(text) > 280)
        return { status: "skipped", reason: "too_long" };
      return this.reserveAndQueue({
        userId,
        kind: "article",
        localId: articleId,
        mode,
        costMicros: X_REFERENCE_PRICES.createWithUrl,
        job: "x.article.sync",
      });
    }
    const conn = await this.connections.getActiveConnection(userId);
    const policy = this.appConfig.xArticle();
    if (
      !conn ||
      !policy.enabled ||
      !policy.accountIds.includes(conn.xUserId) ||
      policy.maximumMicros === undefined ||
      !policy.priceVersion
    )
      return { status: "skipped", reason: "article_access_unconfirmed" };
    try {
      xArticleContent(article.title, article.body);
    } catch {
      return { status: "skipped", reason: "article_format_unsupported" };
    }
    return this.reserveAndQueue({
      userId,
      kind: "article",
      localId: articleId,
      mode,
      costMicros: policy.maximumMicros,
      job: "x.article.sync",
    });
  }

  async syncPost(postId: string, generation?: string): Promise<void> {
    const post = await this.loadPost(postId);
    if (!post) return;
    const row = await this.prisma.xCrosspost.findUnique({
      where: { kind_localId: { kind: "post", localId: postId } },
    });
    if (!row || row.remoteId || row.refundedAt || row.userId !== post.userId)
      return;
    if (post.kind === "board") {
      const boardReason = linkBlocker(post);
      const text = xBoardLinkText(this.appConfig.frontendBaseUrl(), postId, post.boardTitle);
      const reason =
        boardReason ?? (xWeightedLength(text) > 280 ? "too_long" : null);
      if (reason) {
        await this.outcome.fail("post", postId, post.userId, xBlockerMessage(reason));
        return;
      }
      await this.publisher.publish(post.userId, "post", postId, text, [], generation);
      return;
    }
    const reason = xPostBlocker(
      post,
      row.mode,
      this.appConfig.integrationBudget().enabled,
    );
    if (reason) {
      await this.outcome.fail("post", postId, post.userId, xBlockerMessage(reason));
      return;
    }
    await this.publisher.publish(
      post.userId,
      "post",
      postId,
      post.body.trim(),
      post.media,
      generation,
    );
  }

  async syncArticle(articleId: string, generation?: string): Promise<void> {
    return this.articleSync.syncArticle(articleId, generation);
  }

  private async reserveAndQueue(input: {
    userId: string;
    kind: PickaxCrosspostKind;
    localId: string;
    mode: CrosspostMode;
    costMicros: number;
    job: "x.post.sync" | "x.article.sync";
  }): Promise<XQueueResult> {
    if (!(await this.connections.getActiveConnection(input.userId)))
      return { status: "skipped", reason: "not_connected" };
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: {
        premium: true,
        premiumPlus: true,
        verifiedStatus: true,
        bannedAt: true,
      },
    });
    if (!user || user.bannedAt || user.verifiedStatus === "none")
      return { status: "skipped", reason: "verification_required" };
    if (
      !this.appConfig.integrationBudget().enabled &&
      !this.appConfig.partner().xCountAllowance &&
      !user.premium &&
      !user.premiumPlus
    )
      return { status: "skipped", reason: "premium_required" };
    if (
      (input.mode === "link" ||
        (input.kind === "post" &&
          input.costMicros >= X_REFERENCE_PRICES.createWithUrl)) &&
      !user.premiumPlus
    )
      return { status: "skipped", reason: "premium_plus_required" };
    const config = this.appConfig.x();
    if (!config) return { status: "skipped", reason: "not_available" };

    const existing = await this.prisma.xCrosspost.findUnique({
      where: { kind_localId: { kind: input.kind, localId: input.localId } },
    });
    if (existing?.remoteId) return { status: "queued", mode: existing.mode };
    if (existing && !existing.refundedAt) {
      this.dispatch(input);
      return { status: "queued", mode: existing.mode };
    }

    const budgetMicros = config.monthlyBudgetCents * 10_000;
    const reserved = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`x:${input.userId}`}))`;
      const current = await tx.xCrosspost.findUnique({
        where: { kind_localId: { kind: input.kind, localId: input.localId } },
      });
      if (current?.remoteId || (current && !current.refundedAt))
        return "already" as const;
      const spent = await tx.xCrosspost.aggregate({
        where: {
          userId: input.userId,
          refundedAt: null,
          createdAt: { gte: monthStartUtc() },
        },
        _sum: { costMicros: true },
      });
      if (
        !this.appConfig.integrationBudget().enabled &&
        !this.appConfig.partner().xCountAllowance &&
        (spent._sum.costMicros ?? 0) + input.costMicros > budgetMicros
      )
        return "monthly_limit" as const;
      if (current) {
        await tx.xCrosspost.update({
          where: { id: current.id },
          data: {
            mode: input.mode,
            costMicros: input.costMicros,
            refundedAt: null,
            lastError: null,
          },
        });
      } else {
        await tx.xCrosspost.create({
          data: {
            userId: input.userId,
            kind: input.kind,
            localId: input.localId,
            mode: input.mode,
            costMicros: input.costMicros,
          },
        });
      }
      return "ok" as const;
    });
    if (reserved === "monthly_limit")
      return { status: "skipped", reason: "monthly_limit" };
    this.dispatch(input);
    return { status: "queued", mode: input.mode };
  }

  private dispatch(input: {
    userId: string;
    mode: CrosspostMode;
    kind: PickaxCrosspostKind;
    localId: string;
    job: "x.post.sync" | "x.article.sync";
  }): void {
    void this.outbound.ensure(
      input.userId,
      "x",
      input.kind,
      input.localId,
      input.mode,
    );
  }

  private async loadPost(postId: string): Promise<LoadedPost | null> {
    const post = await this.postsRead.findIncludingDeleted({
      where: { id: postId },
      select: {
        userId: true,
        body: true,
        visibility: true,
        kind: true,
        boardOnly: true,
        isDraft: true,
        deletedAt: true,
        scheduledAt: true,
        parentId: true,
        communityGroupId: true,
        quotedPostId: true,
        repostedPostId: true,
        poll: { select: { id: true } },
        boardThread: { select: { title: true } },
        media: {
          select: {
            kind: true,
            source: true,
            r2Key: true,
            alt: true,
            deletedAt: true,
            position: true,
          },
        },
      },
    });
    if (!post) return null;
    const { poll, boardThread, ...rest } = post;
    return {
      ...rest,
      boardTitle: boardThread?.title ?? null,
      hasPoll: Boolean(poll),
    };
  }
}
