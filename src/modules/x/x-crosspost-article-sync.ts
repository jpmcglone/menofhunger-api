import { Injectable } from '@nestjs/common';
import { AppConfigService } from "../app/app-config.service";
import { IntegrationBudgetService } from "./integration-budget.service";
import { PrismaService } from "../prisma/prisma.service";
import { XApiClient } from "./x-api.client";
import { XConnectionService } from "./x-connection.service";
import { XUsageService } from "./x-usage.service";
import { createHash } from "crypto";
import { xArticleContent } from "./x-article-content";
import { X_REFERENCE_PRICES } from "./integration-budget.policy";
import { publicAssetUrl } from "../../common/assets/public-asset-url";
import {
  xWeightedLength,
  xBlockerMessage,
} from "../../common/crosspost/crosspost-eligibility";
import { XCrosspostOutcomeService } from "./x-crosspost-outcome.service";
import { XCrosspostPublishService } from "./x-crosspost-publish";
import { xArticleLinkText } from "./x-crosspost.constants";

@Injectable()
export class XArticleSyncService {
  constructor(
    private readonly outcome: XCrosspostOutcomeService,
    private readonly publisher: XCrosspostPublishService,
    private readonly api: XApiClient,
    private readonly appConfig: AppConfigService,
    private readonly budgets: IntegrationBudgetService,
    private readonly connections: XConnectionService,
    private readonly prisma: PrismaService,
    private readonly usage: XUsageService,
  ) {}

  async syncArticle(articleId: string,
    generation?: string,
  ): Promise<void> {
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
      await this.outcome.fail(
        "article",
        articleId,
        article.authorId,
        "This article is no longer public.",
      );
      return;
    }
    if (row.mode === "link") {
      const text = xArticleLinkText(this.appConfig.frontendBaseUrl(), articleId, article.title);
      const reason = xWeightedLength(text) > 280 ? "too_long" : null;
      if (reason) {
        await this.outcome.fail(
          "article",
          articleId,
          article.authorId,
          xBlockerMessage(reason),
        );
        return;
      }
      await this.publisher.publish(
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
      await this.outcome.fail(
        "article",
        articleId,
        article.authorId,
        "Native X Articles need confirmed account access and pricing.",
      );
      return;
    }
    // A saved draft is evidence of an earlier attempt, not permission to restart it.
    if (row.draftId) {
      await this.outcome.fail(
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
      const token = await this.publisher.freshToken(article.authorId, conn.generation);
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
            ...(await this.publisher.fetchImage(image.url)),
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
            JSON.stringify([current.title, current.body, current.thumbnailR2Key]),
          )
          .digest("hex") !== hash
      ) {
        throw new Error(
          "The source changed after X created a draft. Review the draft on X before publishing.",
        );
      }
      const publishToken = await this.publisher.freshToken(
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
      this.outcome.announce("article", articleId, article.authorId, { xUrl }, true);
    } catch (error) {
      if (reserved && !started)
        await this.budgets.settle(operation, "released", 0);
      const message = started
        ? "X Article delivery needs review. A draft or published copy may exist; check X before retrying."
        : error instanceof Error
          ? error.message
          : "X Article publishing is unavailable.";
      await this.outcome.fail("article", articleId, article.authorId, message);
    }
  }
}

