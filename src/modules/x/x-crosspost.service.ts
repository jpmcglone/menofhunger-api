import { readLimitedResponse } from "../../common/http/read-limited-response";
import { createHash, randomUUID } from "crypto";
import { xArticleContent } from "./x-article-content";
import { IntegrationBudgetService } from "./integration-budget.service";
import { X_REFERENCE_PRICES } from "./integration-budget.policy";
import { OutboundService } from "../outbound/outbound.service";
import { XUsageService } from "./x-usage.service";
import { Injectable, Logger } from "@nestjs/common";
import type { CrosspostMode, PickaxCrosspostKind } from "@prisma/client";
import { publicAssetUrl } from "../../common/assets/public-asset-url";
import {
  X_NATIVE_COST_MICROS,
  X_POST_MAX_IMAGES,
  xPostBlocker,
  xWeightedLength,
  linkBlocker,
  xBlockerMessage,
  xContainsLink,
  xPostCostMicros,
} from "../../common/crosspost/crosspost-eligibility";
import { AppConfigService } from "../app/app-config.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { PrismaService } from "../prisma/prisma.service";
import { XApiClient, XApiError } from "./x-api.client";
import { XConnectionService, monthStartUtc } from "./x-connection.service";

import { PostsReadService } from "../posts-read/posts-read.service";
import { PostsWriteService } from "../posts-read/posts-write.service";
export type XQueueResult =
  | { status: "queued"; mode: CrosspostMode }
  | { status: "skipped"; reason: string };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type LoadedPost = {
  userId: string;
  body: string;
  visibility: string;
  kind: string;
  boardOnly: boolean;
  isDraft: boolean;
  deletedAt: Date | null;
  scheduledAt: Date | null;
  parentId: string | null;
  communityGroupId: string | null;
  quotedPostId: string | null;
  repostedPostId: string | null;
  hasPoll: boolean;
  boardTitle?: string | null;
  media: Array<{
    kind: string;
    source: string;
    r2Key: string | null;
    alt: string | null;
    deletedAt: Date | null;
    position: number;
  }>;
};

@Injectable()
export class XCrosspostService {
  private readonly logger = new Logger(XCrosspostService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: OutboundService,
    private readonly usage: XUsageService,
    private readonly appConfig: AppConfigService,
    private readonly connections: XConnectionService,
    private readonly api: XApiClient,
    private readonly realtime: PresenceRealtimeService,
    private readonly budgets: IntegrationBudgetService,
    private readonly postsRead: PostsReadService,
    private readonly postsWrite: PostsWriteService,
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
      if (xWeightedLength(this.boardLinkText(postId, post.boardTitle)) > 280)
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
      const text = this.articleLinkText(articleId, article.title);
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

  private boardLinkText(id: string, title?: string | null): string {
    const base = (
      this.appConfig.frontendBaseUrl() ?? "https://menofhunger.com"
    ).replace(/\/+$/, "");
    return `${(title ?? "").trim()}\n${base}/b/${encodeURIComponent(id)}`.trim();
  }

  private articleLinkText(id: string, title: string): string {
    return `${title}\n${(this.appConfig.frontendBaseUrl() ?? "https://menofhunger.com").replace(/\/+$/, "")}/a/${encodeURIComponent(id)}`;
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
      const text = this.boardLinkText(postId, post.boardTitle);
      const reason =
        boardReason ?? (xWeightedLength(text) > 280 ? "too_long" : null);
      if (reason) {
        await this.fail("post", postId, post.userId, xBlockerMessage(reason));
        return;
      }
      await this.publish(post.userId, "post", postId, text, [], generation);
      return;
    }
    const reason = xPostBlocker(
      post,
      row.mode,
      this.appConfig.integrationBudget().enabled,
    );
    if (reason) {
      await this.fail("post", postId, post.userId, xBlockerMessage(reason));
      return;
    }
    await this.publish(
      post.userId,
      "post",
      postId,
      post.body.trim(),
      post.media,
      generation,
    );
  }

  async syncArticle(articleId: string, generation?: string): Promise<void> {
    const article = await this.prisma.article.findUnique({
      where: { id: articleId },
    });
    const row = await this.prisma.xCrosspost.findUnique({
      where: { kind_localId: { kind: "article", localId: articleId } },
    });
    if (
      !article ||
      !row ||
      row.remoteId ||
      row.refundedAt ||
      row.userId !== article.authorId
    )
      return;
    if (
      article.deletedAt ||
      article.isDraft ||
      !article.publishedAt ||
      article.visibility !== "public"
    ) {
      await this.fail(
        "article",
        articleId,
        article.authorId,
        "This article is no longer public.",
      );
      return;
    }
    if (row.mode === "link") {
      const text = this.articleLinkText(articleId, article.title);
      const reason = xWeightedLength(text) > 280 ? "too_long" : null;
      if (reason) {
        await this.fail(
          "article",
          articleId,
          article.authorId,
          xBlockerMessage(reason),
        );
        return;
      }
      await this.publish(
        article.authorId,
        "article",
        articleId,
        text,
        [],
        generation,
      );
      return;
    }
    const config = this.appConfig.xArticle();
    const conn = await this.connections.getActiveConnection(article.authorId);
    const policy = this.appConfig.integrationBudget(config.bucket);
    if (
      !policy.enabled ||
      !config.enabled ||
      !conn ||
      (generation && conn.generation !== generation) ||
      !config.accountIds.includes(conn.xUserId) ||
      config.maximumMicros === undefined ||
      !config.priceVersion
    ) {
      await this.fail(
        "article",
        articleId,
        article.authorId,
        "Native X Articles need confirmed account access and pricing.",
      );
      return;
    }
    // A saved draft is evidence of an earlier attempt, not permission to restart it.
    if (row.draftId) {
      await this.fail(
        "article",
        articleId,
        article.authorId,
        "An X draft already exists. Check X before continuing publication.",
      );
      return;
    }
    const operation = `x:article:${articleId}`;
    let reserved = false;
    let started = false;
    try {
      const prepared = xArticleContent(article.title, article.body);
      const images = [...prepared.images];
      const cover = publicAssetUrl({
        publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
        key: article.thumbnailR2Key,
      });
      if (article.thumbnailR2Key && !cover)
        throw new Error("The Article cover could not be prepared for X.");
      if (cover && !images.some((image) => image.url === cover))
        images.push({ url: cover, alt: null });
      if (
        images.length &&
        (policy.imageUploadMaxMicros === undefined ||
          policy.priceVersion !== X_REFERENCE_PRICES.version)
      )
        throw new Error("Article media pricing needs confirmation.");
      // Validate every image origin before reserving or uploading anything.
      const allowedOrigin = this.appConfig.r2()?.publicBaseUrl
        ? new URL(this.appConfig.r2()!.publicBaseUrl!).origin
        : null;
      for (const image of images) {
        const url = new URL(image.url);
        if (url.protocol !== "https:" || url.origin !== allowedOrigin)
          throw new Error("X Articles require images uploaded to MOH.");
      }
      const maximum =
        config.maximumMicros +
        images.reduce(
          (sum, image) =>
            sum +
            (policy.imageUploadMaxMicros ?? 0) +
            (image.alt?.trim() ? X_REFERENCE_PRICES.mediaMetadata : 0),
          0,
        );
      const token = await this.freshToken(article.authorId, conn.generation);
      reserved = await this.budgets.reserve(
        {
          id: operation,
          userId: article.authorId,
          externalAccountId: conn.xUserId,
          provider: "x",
          action: "article",
          bucket: config.bucket,
          maximumMicros: maximum,
          publicationCount: 1,
        },
        { ...policy, priceVersion: config.priceVersion },
      );
      if (!reserved)
        throw new Error(
          "The Article allowance is unavailable or an earlier attempt needs reconciliation.",
        );
      await this.usage.recordShared(
        operation,
        article.authorId,
        conn.xUserId,
        config.bucket === "expensive",
      );
      await this.budgets.settle(operation, "uncertain");
      started = true;
      const ids = new Map<string, string>();
      for (const image of images)
        ids.set(
          image.url,
          await this.api.uploadImage(token, {
            ...(await this.fetchImage(image.url)),
            alt: image.alt,
          }),
        );
      const draft = xArticleContent(article.title, article.body, ids).draft;
      if (cover)
        draft.cover_media = {
          media_category: "tweet_image",
          media_id: ids.get(cover)!,
        };
      const draftId = await this.api.createArticleDraft(token, draft);
      const hash = createHash("sha256")
        .update(
          JSON.stringify([article.title, article.body, article.thumbnailR2Key]),
        )
        .digest("hex");
      // Persist stage one BEFORE publishing. A timeout never loses the draft identity.
      await this.prisma.xCrosspost.update({
        where: { id: row.id },
        data: { draftId, draftSourceHash: hash, costMicros: maximum },
      });
      const current = await this.prisma.article.findUnique({
        where: { id: articleId },
      });
      if (
        !current ||
        current.deletedAt ||
        current.isDraft ||
        current.visibility !== "public" ||
        createHash("sha256")
          .update(
            JSON.stringify([
              current.title,
              current.body,
              current.thumbnailR2Key,
            ]),
          )
          .digest("hex") !== hash
      ) {
        throw new Error(
          "The source changed after X created a draft. Review the draft on X before publishing.",
        );
      }
      const publishToken = await this.freshToken(
        article.authorId,
        conn.generation,
      );
      const remoteId = await this.api.publishArticle(publishToken, draftId);
      const xUrl = `https://x.com/i/status/${remoteId}`;
      await this.prisma.xCrosspost.update({
        where: { id: row.id },
        data: { remoteId, lastError: null },
      });
      await this.prisma.article.updateMany({
        where: { id: articleId },
        data: { xUrl, xError: null },
      });
      await this.budgets.settle(operation, "settled");
      await this.usage.settle(operation, "sent");
      this.announce("article", articleId, article.authorId, { xUrl }, true);
    } catch (error) {
      if (reserved && !started)
        await this.budgets.settle(operation, "released", 0);
      const message = started
        ? "X Article delivery needs review. A draft or published copy may exist; check X before retrying."
        : error instanceof Error
          ? error.message
          : "X Article publishing is unavailable.";
      await this.fail("article", articleId, article.authorId, message);
    }
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

  private async reserveLegacyDeliveryCost(
    userId: string,
    kind: PickaxCrosspostKind,
    localId: string,
    costMicros: number,
  ): Promise<boolean> {
    const config = this.appConfig.x();
    if (!config) return false;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`x:${userId}`}))`;
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          premium: true,
          premiumPlus: true,
          verifiedStatus: true,
          bannedAt: true,
        },
      });
      if (
        !user ||
        user.bannedAt ||
        user.verifiedStatus === "none" ||
        (!user.premium && !user.premiumPlus)
      )
        return false;
      const spent = await tx.xCrosspost.aggregate({
        where: {
          userId,
          refundedAt: null,
          createdAt: { gte: monthStartUtc() },
          NOT: { kind, localId },
        },
        _sum: { costMicros: true },
      });
      if (
        (spent._sum.costMicros ?? 0) + costMicros >
        config.monthlyBudgetCents * 10_000
      )
        return false;
      // Recovery may create the mapping before the request-path reservation runs.
      // Charge the final payload under the same account lock before any network send.
      const updated = await tx.xCrosspost.updateMany({
        where: { userId, kind, localId, remoteId: null },
        data: { costMicros, refundedAt: null },
      });
      return updated.count > 0;
    });
  }

  private async publish(
    userId: string,
    kind: PickaxCrosspostKind,
    localId: string,
    text: string,
    media: LoadedPost["media"],
    generation?: string,
  ): Promise<void> {
    const sharedBudget = this.appConfig.integrationBudget().enabled;
    if (xContainsLink(text) && !sharedBudget) {
      await this.fail(
        kind,
        localId,
        userId,
        xBlockerMessage("links_unsupported"),
      );
      return;
    }
    const conn = await this.connections.getActiveConnection(userId);
    if (!conn || (generation && conn.generation !== generation)) {
      await this.fail(kind, localId, userId, "X is not connected.");
      return;
    }
    const reservationId = `x:${kind}:${localId}`;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        verifiedStatus: true,
        bannedAt: true,
        premium: true,
        premiumPlus: true,
      },
    });
    if (!user || user.bannedAt || user.verifiedStatus === "none") {
      await this.fail(
        kind,
        localId,
        userId,
        "Verify your account before sharing to X.",
      );
      return;
    }
    let costMicros = xPostCostMicros(text);
    if (sharedBudget) {
      const bucket = xContainsLink(text)
        ? "expensive"
        : user.premium || user.premiumPlus
          ? "regular"
          : "acquisition";
      const policy = this.appConfig.integrationBudget(bucket);
      const images = media.filter((item) => !item.deletedAt);
      if (
        (images.length > 0 && policy.imageUploadMaxMicros === undefined) ||
        policy.priceVersion !== X_REFERENCE_PRICES.version
      ) {
        await this.fail(
          kind,
          localId,
          userId,
          "X pricing for this format needs confirmation before it can be sent.",
        );
        return;
      }
      costMicros += images.reduce(
        (sum, image) =>
          sum +
          (policy.imageUploadMaxMicros ?? 0) +
          (image.alt?.trim() ? X_REFERENCE_PRICES.mediaMetadata : 0),
        0,
      );
      if (
        !(await this.budgets.reserve(
          {
            id: reservationId,
            userId,
            externalAccountId: conn.xUserId,
            provider: "x",
            action: "create",
            bucket,
            maximumMicros: costMicros,
            publicationCount: 1,
          },
          policy,
        ))
      ) {
        await this.fail(
          kind,
          localId,
          userId,
          "Your X publication or shared integration allowance is unavailable. Links require Premium+.",
        );
        return;
      }
      await this.prisma.xCrosspost.updateMany({
        where: { kind, localId },
        data: { costMicros },
      });
    } else if (this.appConfig.partner().xCountAllowance) {
      if (
        !(await this.usage.reserve(
          reservationId,
          userId,
          conn.xUserId,
          costMicros > X_NATIVE_COST_MICROS,
        ))
      ) {
        await this.fail(
          kind,
          localId,
          userId,
          "Your monthly X allowance for this kind of post is used up.",
        );
        return;
      }
      await this.prisma.xCrosspost.updateMany({
        where: { kind, localId },
        data: { costMicros },
      });
    } else if (
      !(await this.reserveLegacyDeliveryCost(userId, kind, localId, costMicros))
    ) {
      await this.fail(
        kind,
        localId,
        userId,
        "X sharing is unavailable under this account’s current allowance.",
      );
      return;
    }
    // Legacy retries remain separate accounting attempts: an earlier failed
    // request may still have cost money and must not be overwritten.
    const ledgerId = sharedBudget
      ? reservationId
      : `${reservationId}:attempt:${randomUUID()}`;
    if (!sharedBudget)
      await this.budgets.recordLegacy({
        id: ledgerId,
        userId,
        externalAccountId: conn.xUserId,
        provider: "x",
        action: "create",
        bucket: user.premium || user.premiumPlus ? "regular" : "acquisition",
        maximumMicros: costMicros,
        publicationCount: 1,
      });
    let paidRequestStarted = false;
    let billableMediaAccepted = false;
    try {
      const token = await this.freshToken(userId, conn.generation);
      if (sharedBudget)
        await this.usage.recordShared(
          reservationId,
          userId,
          conn.xUserId,
          xContainsLink(text),
        );
      await this.budgets.settle(ledgerId, "uncertain");
      paidRequestStarted = true;
      billableMediaAccepted = media.some((item) => !item.deletedAt);
      const mediaIds = await this.uploadImages(token, media);
      const remoteId = await this.api.createPost(token, {
        text: text || " ",
        mediaIds,
        ...(sharedBudget ? { allowLinks: true } : {}),
      });
      const username =
        (
          await this.prisma.xConnection.findUnique({
            where: { userId },
            select: { username: true },
          })
        )?.username ?? conn.username;
      await this.prisma.xCrosspost.updateMany({
        where: { kind, localId },
        data: { remoteId, lastError: null },
      });
      const xUrl = `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(remoteId)}`;
      if (kind === "post") {
        await this.postsWrite.write.updateMany({
          where: { id: localId },
          data: { xUrl, xError: null },
        });
      } else {
        await this.prisma.article.updateMany({
          where: { id: localId },
          data: { xUrl, xError: null },
        });
      }
      await this.budgets.settle(ledgerId, "settled");
      await this.usage.settle(reservationId, "sent");
      this.announce(kind, localId, userId, { xUrl }, true);
      await this.connections.clearError(userId);
    } catch (err) {
      const retryLater =
        err instanceof XApiError && err.isRetryable && !sharedBudget;
      // A 4xx before any media upload is a finished rejection: X did not create
      // the post. Timeouts, 5xx, and uploaded media stay held for review.
      const knownRejection =
        !billableMediaAccepted &&
        !retryLater &&
        err instanceof XApiError &&
        !err.duplicateRisk &&
        err.status >= 400 &&
        err.status < 500;
      if (!paidRequestStarted || knownRejection)
        await this.budgets.settle(ledgerId, "released", 0);
      const message = err instanceof Error ? err.message : String(err);
      if (retryLater) {
        this.logger.warn(`X ${kind} ${localId} will retry: ${message}`);
        throw err;
      }
      if (err instanceof XApiError && err.duplicateRisk) {
        await this.usage.settle(reservationId, "uncertain");
        const uncertain = "Delivery is uncertain. Check X before retrying.";
        await this.prisma.xCrosspost.updateMany({
          where: { kind, localId },
          data: { lastError: uncertain },
        });
        if (kind === "post")
          await this.postsWrite.write.updateMany({
            where: { id: localId },
            data: { xError: uncertain },
          });
        else
          await this.prisma.article.updateMany({
            where: { id: localId },
            data: { xError: uncertain },
          });
        this.announce(kind, localId, userId, { xError: uncertain }, false);
        return;
      }
      await this.usage.settle(reservationId, "released");
      const authFailure = err instanceof XApiError && err.isAuthFailure;
      if (authFailure) {
        await this.connections.markError(
          userId,
          "X needs to be connected again.",
          true,
        );
      }
      await this.fail(kind, localId, userId, message.slice(0, 500));
    }
  }

  private async freshToken(
    userId: string,
    generation?: string,
  ): Promise<string> {
    const conn = await this.connections.getActiveConnection(userId);
    if (!conn || (generation && conn.generation !== generation))
      throw new XApiError(401, "not_connected", "X is not connected.");
    try {
      return await this.connections.accessTokenFor(conn);
    } catch (err) {
      if (!(err instanceof XApiError) || !err.isAuthFailure) throw err;
      await this.connections.invalidateAccessToken(userId);
      const fresh = await this.connections.getActiveConnection(userId);
      if (!fresh || fresh.generation !== conn.generation) throw err;
      return this.connections.accessTokenFor(fresh);
    }
  }

  private async uploadImages(
    token: string,
    media: LoadedPost["media"],
  ): Promise<string[]> {
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const images = media
      .filter(
        (item) =>
          !item.deletedAt &&
          item.kind === "image" &&
          item.source === "upload" &&
          item.r2Key,
      )
      .sort((a, b) => a.position - b.position);
    if (images.length > X_POST_MAX_IMAGES)
      throw new XApiError(
        400,
        "too_many_images",
        "X allows up to four photos.",
      );
    const ids: string[] = [];
    for (const image of images) {
      const url = publicAssetUrl({ publicBaseUrl, key: image.r2Key });
      if (!url)
        throw new XApiError(
          400,
          "image_unavailable",
          "A photo could not be prepared for X.",
        );
      const file = await this.fetchImage(url);
      ids.push(await this.api.uploadImage(token, { ...file, alt: image.alt }));
    }
    return ids;
  }

  private async fetchImage(
    url: string,
  ): Promise<{ bytes: Buffer; contentType: string }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new XApiError(400, "image_fetch", "Could not fetch an image.");
    }
    let allowedOrigin: string | null = null;
    try {
      const allowed = this.appConfig.r2()?.publicBaseUrl;
      allowedOrigin = allowed ? new URL(allowed).origin : null;
    } catch {
      allowedOrigin = null;
    }
    if (
      parsed.protocol !== "https:" ||
      !allowedOrigin ||
      parsed.origin !== allowedOrigin
    ) {
      throw new XApiError(400, "image_fetch", "Could not fetch an image.");
    }
    let res: Response;
    try {
      res = await fetch(parsed.toString(), {
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new XApiError(
        0,
        "network_error",
        err instanceof Error ? err.message : "Could not fetch the image.",
      );
    }
    if (!res.ok)
      throw new XApiError(
        res.status,
        "image_fetch",
        `Could not fetch an image (${res.status}).`,
      );
    const contentType =
      res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ??
      "";
    if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      throw new XApiError(
        400,
        "image_fetch",
        "X can only take JPEG, PNG, or WebP photos.",
      );
    }
    const bytes = await readLimitedResponse(res, MAX_IMAGE_BYTES);
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new XApiError(
        400,
        "image_too_large",
        "An image is too large to post on X.",
      );
    return { bytes, contentType };
  }

  private async fail(
    kind: PickaxCrosspostKind,
    localId: string,
    userId: string,
    message: string,
  ): Promise<void> {
    this.logger.warn(`X ${kind} ${localId} failed: ${message}`);
    const note = message.slice(0, 500);
    await this.prisma.xCrosspost.updateMany({
      where: { kind, localId, remoteId: null },
      data: { lastError: note, refundedAt: new Date() },
    });
    await this.usage.settle(`x:${kind}:${localId}`, "released");
    await this.writeError(kind, localId, note);
    this.announce(kind, localId, userId, { xError: note }, false);
  }

  /** Public link goes to the post/article room and the author. Failures stay on the author's socket. */
  private announce(
    kind: PickaxCrosspostKind,
    localId: string,
    userId: string,
    patch: { xUrl?: string; xError?: string },
    isPublic: boolean,
  ): void {
    const version = new Date().toISOString();
    if (kind === "post") {
      const payload = { postId: localId, version, reason: "crosspost", patch };
      if (isPublic) this.realtime.emitPostsLiveUpdated(localId, payload);
      this.realtime.emitPostsLiveUpdatedToUser(userId, payload);
      return;
    }
    const payload = { articleId: localId, version, reason: "crosspost", patch };
    if (isPublic) this.realtime.emitArticlesLiveUpdated(localId, payload);
    this.realtime.emitArticlesLiveUpdatedToUser(userId, payload);
  }

  private async writeError(
    kind: PickaxCrosspostKind,
    localId: string,
    message: string,
  ): Promise<void> {
    if (kind === "post") {
      await this.postsWrite.write.updateMany({
        where: { id: localId },
        data: { xError: message },
      });
    } else {
      await this.prisma.article.updateMany({
        where: { id: localId },
        data: { xError: message },
      });
    }
  }

  private async loadPost(postId: string): Promise<LoadedPost | null> {
    const post = await this.postsRead.read.findUnique({
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
