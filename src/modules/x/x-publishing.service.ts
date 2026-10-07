import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { OutboundDelivery } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import {
  OutboundService,
  OutboundAttentionError,
} from "../outbound/outbound.service";
import { XConnectionService } from "./x-connection.service";
import { XUsageService } from "./x-usage.service";
import { xContainsLink } from "../../common/crosspost/crosspost-eligibility";
import { XApiClient } from "./x-api.client";
import { IntegrationBudgetService } from "./integration-budget.service";
import { XPublicSnapshotService } from "./x-public-snapshot.service";
import { RedisService } from "../redis/redis.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { readLimitedResponse } from "../../common/http/read-limited-response";
import {
  prepareXPlan,
  xPublishingInput,
  xSourceHash,
} from "./x-publishing-plan";
import type { XPublishingWorkspaceDto } from "../../common/dto/integrations.dto";

import { PostsReadService } from '../posts-read/posts-read.service';
@Injectable()
export class XPublishingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly connections: XConnectionService,
    private readonly outbound: OutboundService,
    private readonly api: XApiClient,
    private readonly budgets: IntegrationBudgetService,
    private readonly snapshots: XPublicSnapshotService,
    private readonly redis: RedisService,
    private readonly realtime: PresenceRealtimeService,
    private readonly usage: XUsageService,
    private readonly postsRead: PostsReadService,
  ) {}

  private async source(userId: string, postId: string) {
    const post = await this.postsRead.read.findFirst({
      where: {
        id: postId,
        userId,
        deletedAt: null,
        isDraft: false,
        scheduledAt: null,
        visibility: "public",
        communityGroupId: null,
        boardOnly: false,
        kind: "regular",
        repostedPostId: null,
      },
      select: {
        body: true,
        parentId: true,
        quotedPostId: true,
        media: {
          orderBy: { position: "asc" },
          select: {
            id: true,
            kind: true,
            source: true,
            r2Key: true,
            alt: true,
            deletedAt: true,
          },
        },
        poll: {
          select: {
            endsAt: true,
            options: {
              orderBy: { position: "asc" },
              select: { text: true, imageR2Key: true },
            },
          },
        },
      },
    });
    if (!post)
      throw new NotFoundException("A public post you own is required.");
    return post;
  }

  async workspace(
    userId: string,
    postId: string,
  ): Promise<XPublishingWorkspaceDto> {
    const [source, connection, copy] = await Promise.all([
      this.source(userId, postId),
      this.connections.getActiveConnection(userId),
      this.prisma.xCrosspost.findUnique({
        where: { kind_localId: { kind: "post", localId: postId } },
      }),
    ]);
    const policy = this.config.xPublishing();
    const available = Boolean(
      connection &&
      policy.enabled &&
      policy.accountIds.includes(connection.xUserId) &&
      this.config.integrationBudget().enabled &&
      policy.postMaxMicros !== undefined &&
      policy.priceVersion,
    );
    return {
      sourceHash: xSourceHash(source),
      text: source.body,
      username: connection?.username ?? null,
      available,
      reason: available
        ? null
        : "Advanced X publishing needs confirmed account access and pricing.",
      canQuote:
        available && policy.quoteAccountIds.includes(connection!.xUserId),
      canLongText:
        available && policy.longAccountIds.includes(connection!.xUserId),
      canEdit:
        available &&
        Boolean(copy?.remoteId) &&
        policy.editAccountIds.includes(connection!.xUserId),
      postMaxMicros: policy.postMaxMicros ?? null,
      mediaMaxMicros: policy.mediaMaxMicros ?? null,
      mediaCount: source.media.length,
      hasPoll: Boolean(source.poll),
      remoteUrl: copy?.remoteId
        ? `https://x.com/i/status/${copy.remoteId}`
        : null,
      confirmedUrls: (copy?.remoteIds.length
        ? copy.remoteIds
        : copy?.remoteId
          ? [copy.remoteId]
          : []
      ).map((id) => `https://x.com/i/status/${id}`),
      needsAttention: Boolean(copy?.lastError),
      allowance: await this.budgets.allowance(
        userId,
        new Date(),
        connection?.xUserId,
      ),
    };
  }

  async queue(userId: string, postId: string, raw: unknown) {
    const input = xPublishingInput.parse(raw);
    const [source, conn] = await Promise.all([
      this.source(userId, postId),
      this.connections.getActiveConnection(userId),
    ]);
    if (!conn || !this.config.integrationBudget().enabled)
      throw new BadRequestException(
        "Connect X and enable a funded publishing allowance.",
      );
    if (source.parentId && !input.replyToId)
      throw new BadRequestException("Choose the X post this reply belongs to.");
    if (source.quotedPostId && !input.quoteId)
      throw new BadRequestException("Choose the original X post to quote.");
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`x-plan:${postId}`}))`;
      const key = { kind: "post" as const, localId: postId };
      const copy = await tx.xCrosspost.findUnique({
        where: { kind_localId: key },
      });
      const delivery = await tx.outboundDelivery.findUnique({
        where: {
          platform_resourceKind_resourceId: {
            platform: "x",
            resourceKind: "post",
            resourceId: postId,
          },
        },
      });
      if (
        delivery &&
        (delivery.connectionGeneration !== conn.generation ||
          delivery.status !== "sent")
      )
        throw new ConflictException(
          "An X delivery is already queued or needs review.",
        );
      if (
        (copy && !input.edit) ||
        copy?.lastError ||
        (input.edit && delivery?.status !== "sent")
      )
        throw new ConflictException(
          "Review the existing X copy before publishing again.",
        );
      if (
        input.edit &&
        copy?.deliveryPlan &&
        xPublishingInput.parse(copy.deliveryPlan).parts.length > 1
      )
        throw new BadRequestException("Edit this thread directly on X.");
      let prepared: ReturnType<typeof prepareXPlan>;
      try {
        prepared = prepareXPlan(
          source,
          input,
          this.config.xPublishing(),
          conn.xUserId,
          copy?.remoteId,
        );
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : "Invalid X publication.",
        );
      }
      await tx.xCrosspost.upsert({
        where: { kind_localId: key },
        create: {
          ...key,
          userId,
          mode: "native",
          costMicros: prepared.maximumMicros,
          deliveryPlan: input,
        },
        update: {
          deliveryPlan: input,
          costMicros: prepared.maximumMicros,
          refundedAt: null,
        },
      });
    });
    await this.outbound.ensure(
      userId,
      "x",
      "post",
      postId,
      "native",
      input.edit,
    );
    return { queued: true };
  }

  async send(row: OutboundDelivery): Promise<void> {
    const copy = await this.prisma.xCrosspost.findUnique({
      where: { kind_localId: { kind: "post", localId: row.resourceId } },
    });
    if (!copy?.deliveryPlan)
      throw new OutboundAttentionError("X publishing choices are missing.");
    const input = xPublishingInput.parse(copy.deliveryPlan);
    const source = await this.source(row.userId, row.resourceId);
    const connection = await this.connections.getActiveConnection(row.userId);
    if (!connection || connection.generation !== row.connectionGeneration)
      throw new OutboundAttentionError("Original X connection is unavailable.");
    if (copy.lastError || (copy.remoteId && !input.edit))
      throw new OutboundAttentionError(
        "Check the existing X copy before retrying.",
      );
    const config = this.config.xPublishing();
    const prepared = prepareXPlan(
      source,
      input,
      config,
      connection.xUserId,
      copy.remoteId,
    );
    const policy = {
      ...this.config.integrationBudget(prepared.bucket),
      priceVersion: config.priceVersion,
    };
    const operation = `x:plan:${row.id}:${row.version}`;
    const token = await this.connections.accessTokenFor(connection);
    if (
      !(await this.budgets.reserve(
        {
          id: operation,
          userId: row.userId,
          provider: "x",
          externalAccountId: connection.xUserId,
          action: input.edit ? "edit" : "create",
          bucket: prepared.bucket,
          maximumMicros: prepared.maximumMicros,
          publicationCount: prepared.publications,
        },
        policy,
      ))
    )
      throw new OutboundAttentionError(
        "X allowance is unavailable or this delivery needs reconciliation.",
      );
    let started = false;
    const guard = async () => {
      const [latest, conn, control, intent] = await Promise.all([
        this.source(row.userId, row.resourceId),
        this.connections.getActiveConnection(row.userId),
        this.prisma.integrationSpendControl.findUnique({
          where: { id: "global" },
        }),
        this.prisma.outboundDelivery.findUnique({ where: { id: row.id } }),
      ]);
      if (
        !conn ||
        conn.generation !== row.connectionGeneration ||
        control?.paused ||
        !this.config.xPublishing().enabled ||
        xSourceHash(latest) !== input.sourceHash ||
        intent?.action === "remove" ||
        intent?.version !== row.version ||
        intent?.status !== "sending"
      )
        throw new OutboundAttentionError(
          "The source, connection or spending controls changed. Review the X copy.",
        );
      const leaseUntil = new Date(Date.now() + 120_000);
      const renewed = await this.prisma.outboundDelivery.updateMany({
        where: {
          id: row.id,
          version: row.version,
          status: "sending",
          leaseUntil: { gt: new Date() },
        },
        data: { leaseUntil },
      });
      if (!renewed.count)
        throw new OutboundAttentionError(
          "The delivery lease expired. Check the X copy.",
        );
      row.leaseUntil = leaseUntil;
      if (!started) {
        await this.budgets.settle(operation, "uncertain");
        started = true;
      }
    };
    try {
      const mediaIds: string[] = [];
      for (const media of source.media) {
        const base = this.config.r2()?.publicBaseUrl;
        if (!base || !media.r2Key)
          throw new Error("The source upload is unavailable.");
        const url = new URL(
          `${base.replace(/\/+$/, "")}/${media.r2Key.replace(/^\/+/, "")}`,
        );
        if (url.protocol !== "https:" || url.origin !== new URL(base).origin)
          throw new Error("Invalid source upload.");
        const response = await fetch(url, {
          redirect: "error",
          signal: AbortSignal.timeout(90_000),
        });
        const type = response.headers.get("content-type")?.split(";")[0] ?? "";
        if (
          media.kind === "video" ||
          media.kind === "gif" ||
          type === "image/gif"
        ) {
          if (media.alt?.trim())
            throw new Error(
              "Animated media alt text is not supported by this delivery adapter.",
            );
          mediaIds.push(
            await this.api.uploadMovingMedia(
              token,
              response,
              type === "image/gif" ? "tweet_gif" : "tweet_video",
              guard,
            ),
          );
        } else {
          if (
            !response.ok ||
            !["image/jpeg", "image/png", "image/webp"].includes(type)
          ) {
            await response.body?.cancel();
            throw new Error("Unsupported X photo upload.");
          }
          const bytes = await readLimitedResponse(response, 5 * 1024 * 1024);
          await guard();
          mediaIds.push(
            await this.api.uploadImage(token, {
              bytes,
              contentType: type,
              alt: media.alt,
            }),
          );
        }
      }
      let previous: string | null = input.replyToId;
      const delivered: string[] = [];
      for (const [index, text] of input.parts.entries()) {
        await guard();
        const countOperation = `${operation}:part:${index}`;
        if (!input.edit) {
          await this.usage.recordShared(
            countOperation,
            row.userId,
            connection.xUserId,
            xContainsLink(text) || Boolean(input.quoteId),
          );
          await this.usage.settle(countOperation, "uncertain");
        }
        const remoteId = await this.api.createPost(token, {
          text,
          allowLinks: true,
          mediaIds: index === 0 ? mediaIds : undefined,
          poll: index === 0 ? prepared.poll : undefined,
          replyToId: previous,
          quoteId: index === 0 ? input.quoteId : null,
          previousId: input.edit ? copy.remoteId : null,
        });
        delivered.push(remoteId);
        previous = remoteId;
        // Persist each acknowledged part before sending the next. Never replay a partial thread.
        await this.prisma.xCrosspost.update({
          where: { id: copy.id },
          data: {
            remoteId: delivered[0],
            remoteIds: input.edit
              ? [
                  ...(copy.remoteIds.length
                    ? copy.remoteIds
                    : [copy.remoteId!]),
                  ...delivered,
                ]
              : delivered,
          },
        });
        if (!input.edit) await this.usage.settle(countOperation, "sent");
      }
      await guard();
      const xUrl = `https://x.com/i/status/${delivered[0]}`;
      await this.prisma.post.updateMany({
        where: { id: row.resourceId },
        data: { xUrl, xError: null },
      });
      await this.prisma.xCrosspost.update({
        where: { id: copy.id },
        data: { lastError: null },
      });
      await this.budgets.settle(operation, "settled");
      if (input.edit && copy.remoteId) {
        await this.snapshots.invalidate("x-metrics", copy.remoteId);
        await this.redis.raw().del(`x:public-post-metrics:v1:${copy.remoteId}`);
      }
      const event = {
        postId: row.resourceId,
        version: new Date().toISOString(),
        reason: "crosspost",
        patch: { xUrl, xError: null },
      };
      this.realtime.emitPostsLiveUpdated(row.resourceId, event);
      this.realtime.emitPostsLiveUpdatedToUser(row.userId, event);
    } catch (error) {
      if (!started) await this.budgets.settle(operation, "released", 0);
      const message = started
        ? "X delivery needs review. Check all confirmed parts before retrying."
        : error instanceof Error
          ? error.message
          : "X publication failed.";
      await this.prisma.xCrosspost.update({
        where: { id: copy.id },
        data: { lastError: message },
      });
      await this.prisma.post.updateMany({
        where: { id: row.resourceId },
        data: { xError: message },
      });
      throw new OutboundAttentionError(message);
    }
  }
}
