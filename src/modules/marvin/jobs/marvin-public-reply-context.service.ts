import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { MarvinBotIdentityService } from "../services/marvin-bot-identity.service";
import { MarvinThreadContextService } from "../services/marvin-thread-context.service";
import { PresenceRealtimeService } from "../../presence/presence-realtime.service";
import { PostsReadService } from "../../posts-read/posts-read.service";
import { MarvinJevService } from "../services/marvin-jev.service";
import { isUniqueViolation } from "../../../common/prisma/errors";

import type { ResolvedMarvinMode } from "../services/marvin-routing.service";
import { AppConfigService } from "../../app/app-config.service";
import { type MarvThreadPost } from "../services/marvin-prompt-builder.service";
import { MarvinRoutingService } from "../services/marvin-routing.service";
import {
  type MarvGroupVenue,
  type MarvThreadContextPost,
} from "../services/marvin-thread-context.service";
import {
  TYPING_HEARTBEAT_MS,
  MENTION_NO_REPLY_THRESHOLD,
  MENTION_GATE_MAX_CHARS,
} from "./marvin-public-reply.constants";
import { NOT_DELETED } from '../../../common/prisma/where';

@Injectable()
export class MarvinPublicReplyContextService {
  private readonly logger = new Logger(MarvinPublicReplyContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly identity: MarvinBotIdentityService,
    private readonly threadContext: MarvinThreadContextService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly postsRead: PostsReadService,
    @Optional() private readonly jev?: MarvinJevService,
  ) {}

  async mentionNeedsNoReply(
    text: string,
    mediaCount: number,
    parentId: string | null,
  ): Promise<boolean> {
    if (
      !this.jev ||
      mediaCount > 0 ||
      text.includes("?") ||
      text.length > MENTION_GATE_MAX_CHARS
    )
      return false;
    if (!this.jev.replyGateAvailable()) return false;
    // "yes please" only makes sense next to what it answers, so give Jev the message being replied to.
    const parent = parentId
      ? await this.postsRead.findFirst({
          where: { id: parentId, ...NOT_DELETED },
          select: { body: true, user: { select: { id: true } } },
        })
      : null;
    const marvId = this.identity.cachedMarvUserId();
    const probability = await this.jev.replyExpectedProbability({
      text,
      previous: parent
        ? {
            text: parent.body ?? "",
            fromMarv: Boolean(marvId && parent.user.id === marvId),
          }
        : null,
    });
    return probability !== null && probability < MENTION_NO_REPLY_THRESHOLD;
  }

  async correctionContext(parentId: string | null): Promise<{
    replyingTo: { text: string; fromMarv: boolean } | null;
    priorEffectiveMode: ResolvedMarvinMode | null;
  }> {
    if (!parentId) return { replyingTo: null, priorEffectiveMode: null };
    const parent = await this.postsRead.findFirst({
      where: { id: parentId, ...NOT_DELETED },
      select: { body: true, parentId: true, userId: true },
    });
    if (!parent) return { replyingTo: null, priorEffectiveMode: null };
    const marvId = this.identity.cachedMarvUserId();
    const fromMarv = Boolean(marvId && parent.userId === marvId);
    let priorEffectiveMode: ResolvedMarvinMode | null = null;
    if (fromMarv && parent.parentId) {
      const prior = await this.prisma.marvinUsageEvent.findFirst({
        where: {
          source: "public_thread",
          sourceId: parent.parentId,
          errorCode: null,
        },
        orderBy: { createdAt: "desc" },
        select: { effectiveMode: true },
      });
      priorEffectiveMode = MarvinRoutingService.asResolvedMode(
        prior?.effectiveMode,
      );
    }
    return {
      replyingTo: { text: parent.body ?? "", fromMarv },
      priorEffectiveMode,
    };
  }

  startTypingHeartbeat(args: {
    postId: string;
    marvUserId: string;
    username: string;
  }): {
    stop: () => void;
  } {
    const { postId, marvUserId, username } = args;
    const noop = { stop: () => {} };
    if (!postId || !marvUserId) return noop;

    const marvUsername = username;
    let stopped = false;

    const emit = (typing: boolean): void => {
      try {
        this.presenceRealtime.emitPostsTyping(postId, {
          postId,
          user: {
            id: marvUserId,
            username: marvUsername,
            verifiedStatus: "manual",
            premium: true,
            premiumPlus: false,
            isOrganization: false,
          },
          typing,
          status: typing ? "replying" : undefined,
        });
      } catch {
        // best-effort: typing indicator is non-essential UX
      }
    };

    emit(true);
    const interval = setInterval(() => {
      if (!stopped) emit(true);
    }, TYPING_HEARTBEAT_MS);

    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(interval);
        emit(false);
      },
    };
  }

  async fetchBidirectionalContext(
    triggeringPostId: string,
    openAICfg: ReturnType<AppConfigService["marvOpenAI"]>,
  ): Promise<{
    ancestors: MarvThreadPost[];
    triggeringPost: MarvThreadPost | undefined;
    descendants: MarvThreadPost[];
    imageUrls: string[];
    hasGifAttached: boolean;
    group: MarvGroupVenue | null;
  }> {
    const emptyResult = {
      ancestors: [] as MarvThreadPost[],
      triggeringPost: undefined as MarvThreadPost | undefined,
      descendants: [] as MarvThreadPost[],
      imageUrls: [] as string[],
      hasGifAttached: false,
      group: null as MarvGroupVenue | null,
    };
    try {
      const context = await this.threadContext.collect({
        focalPostId: triggeringPostId,
      });

      const toThreadPost = (p: MarvThreadContextPost): MarvThreadPost => ({
        id: p.id,
        authorUsername: p.authorUsername,
        authorDisplayName: p.authorDisplayName,
        body: p.body,
        createdAt: p.createdAt.toISOString(),
        isMarv: p.isMarv,
        checkinPrompt: p.checkinPrompt,
        poll: p.poll ?? null,
        media: p.media,
        urls: p.urls,
      });

      const ancestors = context.ancestors.map(toThreadPost);
      const triggeringPost = context.focal
        ? toThreadPost(context.focal)
        : undefined;
      const descendants = context.descendants.map(toThreadPost);

      // Image selection across the whole collected conversation (shared with "Catch me up").
      const { imageUrls, hasGifAttached } = this.threadContext.selectImageMedia(
        context,
        {
          visionEnabled: openAICfg.visionEnabled,
          visionMaxImagesPerTurn: openAICfg.visionMaxImagesPerTurn,
          publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
        },
      );

      return {
        ancestors,
        triggeringPost,
        descendants,
        imageUrls,
        hasGifAttached,
        group: context.group,
      };
    } catch (err) {
      this.logger.warn(
        `[marv] fetchBidirectionalContext failed for focal=${triggeringPostId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return emptyResult;
    }
  }

  async tryClaimIdempotency(key: string): Promise<boolean> {
    try {
      await this.prisma.marvinIdempotencyKey.create({ data: { key } });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }
}
