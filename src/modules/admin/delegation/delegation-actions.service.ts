import { Inject } from '@nestjs/common';
import { PostsDraftsService } from '../../posts/posts-drafts.service';
import { PostsFeedLookupService } from '../../posts/posts-feed-lookup.service';
import { PostsMutationEditsService } from '../../posts/posts-mutation-edits.service';
import { PostsMutationWriteService } from '../../posts/posts-mutation-write.service';
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { BoardService } from "../../board/board.service";

import { ScheduledPostsService } from "../../posts/scheduled-posts.service";
import { BookmarksService } from "../../bookmarks/bookmarks.service";
import { SpacesService } from "../../spaces/spaces.service";
import { UsersProfileWriteService } from "../../users/users-profile-write.service";
import { FeedbackService } from "../../feedback/feedback.service";
import { ReportsService } from "../../reports/reports.service";
import { VerificationService } from "../../verification/verification.service";
import { NewslettersService } from "../../newsletters/newsletters.service";
import { AppConfigService } from "../../app/app-config.service";
import { PresenceRealtimeService } from "../../presence/presence-realtime.service";
import { actionSchema, type DelegatedActionInput } from "./delegation.schemas";

import { createHash } from "node:crypto";
import { PostsReadService } from '../../posts-read/posts-read.service';
import { NOT_DELETED } from '../../../common/prisma/where';
export function actionSubjectKey(
  ownerId: string,
  actorId: string,
  input: DelegatedActionInput,
): string | null {
  const subject =
    input.operation === "post_publish" && input.parentId
      ? `reply:${ownerId}:${actorId}:${input.parentId}`
      : null;
  return subject ? createHash("sha256").update(subject).digest("hex") : null;
}
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
export function publicationBody(
  input: Extract<DelegatedActionInput, { operation: "post_publish" }>,
) {
  return [
    input.body,
    ...input.sources
      .filter((s) => !input.body.includes(s.url))
      .map((s) => `${s.title}: ${s.url}`),
  ].join("\n\n");
}
@Injectable()
export class DelegationActionsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PostsDraftsService) private readonly postsDrafts: Pick<PostsDraftsService, 'listDrafts' | 'createDraft' | 'updateDraft'>,
    @Inject(PostsFeedLookupService) private readonly postsLookup: Pick<PostsFeedLookupService, 'getById'>,
    @Inject(PostsMutationEditsService) private readonly postsMutationEdits: Pick<PostsMutationEditsService, 'publishFromOnlyMe' | 'updatePost'>,
    @Inject(PostsMutationWriteService) private readonly postsMutationWrite: Pick<PostsMutationWriteService, 'createPost'>,
    private readonly scheduled: ScheduledPostsService,
    private readonly bookmarks: BookmarksService,
    private readonly spaces: SpacesService,
    private readonly profiles: UsersProfileWriteService,
    private readonly feedback: FeedbackService,
    private readonly reports: ReportsService,
    private readonly verification: VerificationService,
    private readonly newsletters: NewslettersService,
    private readonly config: AppConfigService,
    private readonly realtime: PresenceRealtimeService,
    private readonly board: BoardService,
    private readonly postsRead: PostsReadService,
  ) {}

  async assertFreshSubject(
    ownerId: string,
    actorId: string,
    input: DelegatedActionInput,
    excludeId?: string,
  ) {
    if (input.operation !== "post_publish" || !input.parentId) return;
    const field = "parentId";
    const value = input.parentId;
    const existing = await this.prisma.delegationAction.findFirst({
      where: {
        ...(excludeId ? { id: { not: excludeId } } : {}),
        operation: input.operation,
        status: { in: ["pending", "applying", "complete", "uncertain"] },
        run: { job: { ownerId, actorId } },
        input: { path: [field], equals: value },
      },
      select: { id: true },
    });
    if (existing)
      throw new BadRequestException(
        "This subject already has a pending or completed action. Inspect its existing receipt.",
      );
  }
  async drafts(actorId: string) {
    return this.postsDrafts.listDrafts({ userId: actorId, limit: 30, cursor: null });
  }
  async snapshot(
    actorId: string,
    input: DelegatedActionInput,
  ): Promise<Record<string, unknown>> {
    this.assertPublication(input);
    const draftId = "draftId" in input ? input.draftId : undefined;
    if (draftId) {
      const draft = await this.draft(actorId, draftId);
      return json({
        id: draft.id,
        body: draft.body,
        media: draft.media.map((m) => ({ id: m.id, alt: m.alt, kind: m.kind })),
      });
    }
    let row: unknown = { state: "new" };
    switch (input.operation) {
      case "post_update":
        row = await this.postsRead.findFirst({
          where: {
            id: input.postId,
            userId: actorId,
            ...NOT_DELETED,
            isDraft: false,
          },
          select: { id: true, body: true, editedAt: true },
        });
        break;
      case "post_publish":
        if (input.parentId)
          row = await this.postsLookup.getById({
            viewerUserId: actorId,
            id: input.parentId,
          });
        break;
      case "bookmark_save":
        row = await this.postsLookup.getById({
          viewerUserId: actorId,
          id: input.postId,
        });
        break;
      case "profile_update":
        row = await this.prisma.user.findUnique({
          where: { id: actorId },
          select: { id: true, name: true, bio: true, website: true },
        });
        break;
      case "event_update":
        row = await this.prisma.space.findFirst({
          where: { id: input.spaceId, ownerId: actorId },
          select: {
            id: true,
            title: true,
            description: true,
            scheduledAt: true,
          },
        });
        break;
      case "feedback_update":
        row = await this.prisma.feedback.findUnique({
          where: { id: input.targetId },
          select: {
            id: true,
            subject: true,
            status: true,
            adminNote: true,
            updatedAt: true,
          },
        });
        break;
      case "report_update":
        row = await this.prisma.report.findUnique({
          where: { id: input.targetId },
          select: { id: true, status: true, adminNote: true, updatedAt: true },
        });
        break;
      case "verification_approve":
      case "verification_reject":
        row = await this.prisma.verificationRequest.findFirst({
          where: { id: input.targetId, status: "pending" },
          select: { id: true, userId: true, status: true, updatedAt: true },
        });
        break;
      case "newsletter_send":
        row = await this.newsletters.getAdmin(input.newsletterId);
        break;
    }
    if (!row) throw new NotFoundException("This item is no longer available.");
    // Counters on a reply target may change without invalidating the proposed reply.
    if (
      input.operation === "post_publish" ||
      input.operation === "bookmark_save"
    ) {
      const p = row as { id?: string; body?: string };
      return { id: p.id ?? null, body: p.body ?? null };
    }
    return json(row);
  }
  private assertPublication(input: DelegatedActionInput) {
    if (
      input.operation === "post_publish" &&
      input.board &&
      (input.parentId || input.draftId || input.visibility === "onlyMe")
    )
      throw new BadRequestException(
        "Board publications cannot be replies or Only me drafts. Choose public, verifiedOnly, or premiumOnly.",
      );
  }
  private async draft(actorId: string, id: string) {
    const draft = await this.postsRead.findFirst({
      where: {
        id,
        userId: actorId,
        isDraft: true,
        ...NOT_DELETED,
        scheduledAt: null,
      },
      include: {
        media: { where: NOT_DELETED, orderBy: { position: "asc" } },
      },
    });
    if (!draft)
      throw new NotFoundException(
        "Choose an existing draft owned by this account.",
      );
    return draft;
  }
  async execute(
    ownerId: string,
    actorId: string,
    raw: unknown,
  ): Promise<{ receipt: string; path: string | null }> {
    const input = actionSchema.parse(raw);
    this.assertPublication(input);
    const link = (receipt: string, path: string | null = null) => ({
      receipt,
      path,
    });
    switch (input.operation) {
      case "post_publish": {
        if (input.draftId && input.parentId)
          throw new BadRequestException(
            "A draft cannot be published as a reply.",
          );
        if (input.draftId && input.visibility === "onlyMe")
          throw new BadRequestException(
            "Use draft editing to keep this draft in Only me.",
          );
        const body = publicationBody(input);
        if (input.board) {
          const thread = await this.board.createThread(actorId, {
            ...input.board,
            url: input.board.url ?? null,
            body,
            image: null,
            visibility: input.visibility as
              | "public"
              | "verifiedOnly"
              | "premiumOnly",
          });
          return link(
            input.board.showInFeed
              ? "Board post published and shared to the feed."
              : "Board post published without feed sharing.",
            `/p/${thread.id}`,
          );
        }
        const result = input.draftId
          ? await this.postsMutationEdits.publishFromOnlyMe({
              userId: actorId,
              sourcePostId: input.draftId,
              body,
              visibility: input.visibility as
                | "public"
                | "verifiedOnly"
                | "premiumOnly",
            })
          : await this.postsMutationWrite.createPost({
              userId: actorId,
              body,
              visibility: input.visibility,
              parentId: input.parentId,
              media: null,
              poll: null,
            });
        return link(
          input.visibility === "onlyMe"
            ? "Post saved to Only me for this account."
            : input.parentId
              ? "Reply published."
              : "Post published.",
          input.visibility === "onlyMe" && actorId !== ownerId
            ? null
            : `/p/${"post" in result ? result.post.id : result.id}`,
        );
      }
      case "post_draft": {
        await this.postsDrafts.createDraft({
          userId: actorId,
          body: input.body,
          media: null,
        });
        return link(
          "Draft saved. Use this account’s Only me view to attach media.",
          actorId === ownerId ? "/only-me" : null,
        );
      }
      case "post_draft_update":
        await this.postsDrafts.updateDraft({
          userId: actorId,
          draftId: input.draftId,
          body: input.body,
          media: null,
        });
        return link(
          "Draft updated. Existing media kept.",
          actorId === ownerId ? "/only-me" : null,
        );
      case "post_update":
        await this.postsMutationEdits.updatePost({
          userId: actorId,
          postId: input.postId,
          body: input.body,
        });
        return link("Post updated.", `/p/${input.postId}`);
      case "post_schedule": {
        if (Date.parse(input.scheduledAt) <= Date.now())
          throw new BadRequestException("Choose a future publication time.");
        const draft = input.draftId
          ? await this.draft(actorId, input.draftId)
          : null;
        const media = draft?.media.map((m) => ({
          source: m.source as "upload" | "giphy",
          kind: m.kind as "image" | "gif" | "video",
          r2Key: m.r2Key ?? undefined,
          thumbnailR2Key: m.thumbnailR2Key ?? undefined,
          url: m.url ?? undefined,
          mp4Url: m.mp4Url ?? undefined,
          width: m.width ?? undefined,
          height: m.height ?? undefined,
          durationSeconds: m.durationSeconds ?? undefined,
          alt: m.alt,
        }));
        await this.scheduled.createScheduled({
          userId: actorId,
          body: input.body,
          scheduledAt: new Date(input.scheduledAt),
          visibility: input.visibility,
          communityGroupId: null,
          media: media ?? null,
          poll: null,
        });
        return link(
          "Post scheduled with its media. View Scheduled while using this account.",
          actorId === ownerId ? "/scheduled" : null,
        );
      }
      case "bookmark_save":
        await this.bookmarks.setBookmark({
          userId: actorId,
          postId: input.postId,
          collectionIds: input.collectionIds,
        });
        return link(
          "Saved posts updated for this account.",
          actorId === ownerId ? "/bookmarks" : null,
        );
      case "bookmark_collection":
        await this.bookmarks.createCollection({
          userId: actorId,
          name: input.name,
        });
        return link(
          "Saved-post collection created for this account.",
          actorId === ownerId ? "/bookmarks" : null,
        );
      case "profile_update": {
        const { name, bio, website } = input;
        if (name === undefined && bio === undefined && website === undefined)
          throw new BadRequestException("Choose a profile change.");
        await this.profiles.commit(actorId, { name, bio, website });
        return link(
          "Profile updated.",
          `/u/${(await this.prisma.user.findUniqueOrThrow({ where: { id: actorId }, select: { username: true } })).username}`,
        );
      }
      case "event_create": {
        const space = await this.spaces.createSpace(actorId, input);
        return link("Event space created.", `/s/${space.id}`);
      }
      case "event_update": {
        if (input.title !== undefined || input.description !== undefined)
          await this.spaces.updateSpace(input.spaceId, actorId, input);
        if (input.scheduledAt)
          await this.spaces.setSchedule(
            input.spaceId,
            actorId,
            input.scheduledAt,
          );
        return link("Event updated.", `/s/${input.spaceId}`);
      }
      case "feedback_update":
        await this.feedback.updateAdmin(input.targetId, input);
        this.realtime.emitAdminUpdated(ownerId, {
          kind: "feedback",
          action: "updated",
          id: input.targetId,
        });
        return link("Feedback updated.", "/admin/feedback");
      case "report_update":
        await this.reports.updateAdmin(input.targetId, {
          ...input,
          adminId: ownerId,
        });
        this.realtime.emitAdminUpdated(ownerId, {
          kind: "reports",
          action: "updated",
          id: input.targetId,
        });
        return link(
          "Report decision recorded. No member was banned or content removed.",
          "/admin/reports",
        );
      case "verification_approve":
        await this.verification.approveAdmin({
          requestId: input.targetId,
          adminUserId: ownerId,
          adminNote: input.adminNote ?? null,
        });
        return link("Verification approved.", "/admin/verification");
      case "verification_reject":
        await this.verification.rejectAdmin({
          requestId: input.targetId,
          adminUserId: ownerId,
          rejectionReason: input.rejectionReason,
          adminNote: input.adminNote ?? null,
        });
        return link("Verification rejected.", "/admin/verification");
      case "newsletter_create": {
        const bodyJson = JSON.stringify({
          type: "doc",
          content: input.body.split(/\n\n+/).map((text) => ({
            type: "paragraph",
            content: [{ type: "text", text }],
          })),
        });
        const result = await this.newsletters.create(ownerId, {
          subject: input.subject,
          bodyJson,
          audienceFilters: input.audienceFilters,
        });
        return link(
          "Campaign newsletter drafted.",
          `/admin/newsletters/${result.id}`,
        );
      }
      case "newsletter_send": {
        if (!this.config.email() || !this.config.newsletterPostalAddress())
          throw new BadRequestException(
            "Newsletter delivery is unavailable with the current configuration. The draft is saved.",
          );
        await this.newsletters.sendNow(input.newsletterId);
        return link(
          "Newsletter queued for delivery.",
          `/admin/newsletters/${input.newsletterId}`,
        );
      }
      case "export":
        return link("Export prepared. Download it from this action.");
    }
  }
}
