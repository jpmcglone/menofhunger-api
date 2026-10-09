import { NotificationCleanupService } from "../notifications";
import { NotificationEngagementWriterService } from "../notifications/notification-engagement-writer.service";
import { Injectable, Optional, Inject } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { PostsTopicsClassifyService } from "./posts-topics-classify.service";
import { EmbeddingsService } from "../embeddings/embeddings.service";
import { type SideEffectPayloads } from "../side-effects/side-effects.constants";
import { NOT_DELETED } from "../../common/prisma/where";

@Injectable()
export class PostsEngagementEffectsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NotificationEngagementWriterService)
    private readonly notificationEngagementWriterService: Pick<
      NotificationEngagementWriterService,
      | "deleteBoostNotification"
      | "deleteRepostNotification"
      | "upsertRepostNotification"
      | "upsertBoostNotification"
    >,
    @Inject(NotificationCleanupService)
    private readonly notificationWriterService: Pick<
      NotificationCleanupService,
      "deleteBySubjectPostId" | "deleteByActorPostId"
    >,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly topicsClassify: PostsTopicsClassifyService,
    @Optional() private readonly embeddings?: EmbeddingsService,
  ) {}

  async onEngagementChanged(
    payload: SideEffectPayloads["post.engagement.changed"],
  ): Promise<void> {
    const { kind, active, postId, recipientUserId, actorUserId } = payload;
    if (!postId || !recipientUserId || !actorUserId) return;

    if (!active) {
      await (kind === "boost"
        ? this.notificationEngagementWriterService.deleteBoostNotification(
            recipientUserId,
            actorUserId,
            postId,
          )
        : this.notificationEngagementWriterService.deleteRepostNotification(
            recipientUserId,
            actorUserId,
            postId,
          ));
      return;
    }

    if (kind === "repost") {
      await this.notificationEngagementWriterService.upsertRepostNotification({
        recipientUserId,
        actorUserId,
        subjectPostId: postId,
        actorPostId: payload.actorPostId ?? undefined,
      });
      return;
    }

    // Re-read the body so a retry carries the post's current text, not a request-time snapshot.
    const post = await this.prisma.post.findFirst({
      where: { id: postId, ...NOT_DELETED },
      select: { body: true, kind: true },
    });
    if (!post) return;

    await this.notificationEngagementWriterService.upsertBoostNotification({
      recipientUserId,
      actorUserId,
      subjectPostId: postId,
      bodySnippet: (post.body ?? "").trim().slice(0, 150) || null,
      subjectPostKind: post.kind,
    });
  }

  async onQuoteChanged(
    payload: SideEffectPayloads["post.quote.changed"],
  ): Promise<void> {
    const { postId, actorUserId, prevQuotedPostId, nextQuotedPostId } = payload;
    if (!postId || !actorUserId) return;

    // Fetch the editing post body for the new-target notification snippet.
    const editingPost = await this.prisma.post.findFirst({
      where: { id: postId, ...NOT_DELETED },
      select: { body: true },
    });

    // Delete the quote notification on the old target (if any and non-self).
    if (prevQuotedPostId) {
      const prevOwner = await this.prisma.post.findFirst({
        where: { id: prevQuotedPostId },
        select: { userId: true },
      });
      if (prevOwner && prevOwner.userId !== actorUserId) {
        // Uses the same notification row as a regular repost; keyed by
        // (recipientUserId, actorUserId, subjectPostId=quoted, kind='repost').
        await this.notificationEngagementWriterService.deleteRepostNotification(
          prevOwner.userId,
          actorUserId,
          prevQuotedPostId,
        );
      }
    }

    // Upsert a new quote notification on the new target (if any and non-self).
    if (nextQuotedPostId && editingPost) {
      const nextTarget = await this.prisma.post.findFirst({
        where: { id: nextQuotedPostId, ...NOT_DELETED },
        select: { userId: true },
      });
      if (nextTarget && nextTarget.userId !== actorUserId) {
        await this.notificationEngagementWriterService.upsertRepostNotification(
          {
            recipientUserId: nextTarget.userId,
            actorUserId,
            subjectPostId: nextQuotedPostId,
            actorPostId: postId,
            title: "quoted your post",
          },
        );
      }
    }

    // Best-effort realtime emits so open viewers see the updated quote counts.
    const now = new Date().toISOString();
    for (const pid of [prevQuotedPostId, nextQuotedPostId].filter(
      Boolean,
    ) as string[]) {
      try {
        this.presenceRealtime.emitPostsLiveUpdated(pid, {
          postId: pid,
          version: now,
          reason: "quote_count_changed",
          patch: {},
        });
      } catch {
        /* best-effort */
      }
    }

    // Re-emit on the editing post so its viewers pick up the new body.
    if (editingPost) {
      try {
        this.presenceRealtime.emitPostsLiveUpdated(postId, {
          postId,
          version: now,
          reason: "post_edited",
          patch: { body: editingPost.body ?? "" },
        });
      } catch {
        /* best-effort */
      }
    }
  }

  async onPostDeleted(
    payload: SideEffectPayloads["post.deleted"],
  ): Promise<void> {
    const postId = (payload.postId ?? "").trim();
    if (!postId) return;
    await Promise.allSettled([
      this.notificationWriterService.deleteBySubjectPostId(postId),
      this.notificationWriterService.deleteByActorPostId(postId),
    ]);
  }

  async onSearchNoteRecorded(
    payload: SideEffectPayloads["media.searchNote.recorded"],
  ): Promise<void> {
    const postId = (payload.postId ?? "").trim();
    const r2Key = (payload.r2Key ?? "").trim();
    if (!postId || !r2Key) return;
    const note = await this.prisma.mediaSearchNote.findUnique({
      where: { r2Key },
      select: { note: true },
    });
    if (!note) return;
    await this.topicsClassify.classifyFromImageNote(postId, note.note);
    await this.embeddings?.indexPostIfMissing(postId);
  }
}
