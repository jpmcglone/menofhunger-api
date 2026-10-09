import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from "../app/app-config.service";
import { IntegrationBudgetService } from "./integration-budget.service";
import { PostsWriteService } from "../posts-read/posts-write.service";
import { PrismaService } from "../prisma/prisma.service";
import { XApiClient, XApiError } from "./x-api.client";
import { XConnectionService, monthStartUtc } from "./x-connection.service";
import { XCrosspostOutcomeService } from "./x-crosspost-outcome.service";
import { XUsageService } from "./x-usage.service";
import { readLimitedResponse } from "../../common/http/read-limited-response";
import { randomUUID } from "crypto";
import { X_REFERENCE_PRICES } from "./integration-budget.policy";
import type { PickaxCrosspostKind } from "@prisma/client";
import { publicAssetUrl } from "../../common/assets/public-asset-url";
import {
  X_NATIVE_COST_MICROS,
  X_POST_MAX_IMAGES,
  xBlockerMessage,
  xContainsLink,
  xPostCostMicros,
} from "../../common/crosspost/crosspost-eligibility";
import { MAX_IMAGE_BYTES, type LoadedPost } from "./x-crosspost.constants";

@Injectable()
export class XCrosspostPublishService {
  private readonly logger = new Logger(XCrosspostPublishService.name);

  constructor(
    private readonly outcome: XCrosspostOutcomeService,
    private readonly api: XApiClient,
    private readonly appConfig: AppConfigService,
    private readonly budgets: IntegrationBudgetService,
    private readonly connections: XConnectionService,
    private readonly postsWrite: PostsWriteService,
    private readonly prisma: PrismaService,
    private readonly usage: XUsageService,
  ) {}

  async publish(userId: string,
    kind: PickaxCrosspostKind,
    localId: string,
    text: string,
    media: LoadedPost["media"],
    generation?: string,
  ): Promise<void> {
    const sharedBudget = this.appConfig.integrationBudget().enabled;
    if (xContainsLink(text) && !sharedBudget) {
      await this.outcome.fail(
        kind,
        localId,
        userId,
        xBlockerMessage("links_unsupported"),
      );
      return;
    }
    const conn = await this.connections.getActiveConnection(userId);
    if (!conn || (generation && conn.generation !== generation)) {
      await this.outcome.fail(kind, localId, userId, "X is not connected.");
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
      await this.outcome.fail(
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
        await this.outcome.fail(
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
        await this.outcome.fail(
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
        await this.outcome.fail(
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
      await this.outcome.fail(
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
        await this.postsWrite.recordCrosspostResult(localId, 'x', { url: xUrl, error: null });
      } else {
        await this.prisma.article.updateMany({
          where: { id: localId },
          data: { xUrl, xError: null },
        });
      }
      await this.budgets.settle(ledgerId, "settled");
      await this.usage.settle(reservationId, "sent");
      this.outcome.announce(kind, localId, userId, { xUrl }, true);
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
          await this.postsWrite.recordCrosspostResult(localId, 'x', { error: uncertain });
        else
          await this.prisma.article.updateMany({
            where: { id: localId },
            data: { xError: uncertain },
          });
        this.outcome.announce(kind, localId, userId, { xError: uncertain }, false);
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
      await this.outcome.fail(kind, localId, userId, message.slice(0, 500));
    }
  }

  async freshToken(userId: string,
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

  async uploadImages(token: string,
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
      throw new XApiError(400, "too_many_images", "X allows up to four photos.");
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

  async fetchImage(url: string,
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
      res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
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

  async reserveLegacyDeliveryCost(userId: string,
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
}





