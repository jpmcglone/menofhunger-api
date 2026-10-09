import { Injectable, Logger } from "@nestjs/common";
import type { PickaxCrosspostKind } from "@prisma/client";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { PostsWriteService } from "../posts-read/posts-write.service";
import { PrismaService } from "../prisma/prisma.service";
import { XUsageService } from "./x-usage.service";

/** Terminal bookkeeping for one X crosspost attempt: failure state, usage release, and author/room realtime. */
@Injectable()
export class XCrosspostOutcomeService {
  private readonly logger = new Logger(XCrosspostOutcomeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: XUsageService,
    private readonly realtime: PresenceRealtimeService,
    private readonly postsWrite: PostsWriteService,
  ) {}

  async fail(
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
  announce(
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

  async writeError(
    kind: PickaxCrosspostKind,
    localId: string,
    message: string,
  ): Promise<void> {
    if (kind === "post") {
      await this.postsWrite.recordCrosspostResult(localId, 'x', { error: message });
    } else {
      await this.prisma.article.updateMany({
        where: { id: localId },
        data: { xError: message },
      });
    }
  }
}
