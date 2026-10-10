import { Inject, Injectable, Logger } from "@nestjs/common";
import { MessagesRealtimeService } from "../messages/messages-realtime.service";
import { ChannelMessagesService } from "../group-channels/channel-messages.service";
import { AdminImageReviewStorageService } from "./admin-image-review-storage.service";
import { AdminImageReferencesService } from "./admin-image-review-references.service";
import { AdminImageReviewSyncService } from "./admin-image-review-sync.service";
import { PrismaService } from "../prisma/prisma.service";
import { PublicProfileCacheService } from "../users/public-profile-cache.service";
import { clampLimit } from "../../common/pagination/page";
import { USER_REF_SELECT } from "../../common/prisma-selects/user.select";
import { isProtectedChannelKey } from "../group-channels/channel-media.service";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { scrubKeyFromArticleBody } from "./admin-image-review.references";
import {
  decodeCursor,
  emptyAssetRefs,
  encodeCursor,
  referencesToken,
} from "./admin-image-review.types";

@Injectable()
export class AdminImageReviewActionsService {
  private readonly logger = new Logger(AdminImageReviewActionsService.name);
  constructor(
    private readonly storage: AdminImageReviewStorageService,
    private readonly references: AdminImageReferencesService,
    private readonly sync: AdminImageReviewSyncService,
    private readonly prisma: PrismaService,
    private readonly publicProfileCache: PublicProfileCacheService<{
      id: string;
      username: string | null;
    }>,
    @Inject(MessagesRealtimeService)
    private readonly messagesRealtime: Pick<
      MessagesRealtimeService,
      "rebroadcastMessage"
    >,
    @Inject(ChannelMessagesService)
    private readonly channelMessages: Pick<
      ChannelMessagesService,
      "publishMediaChange"
    >,
  ) {}

  async deleteById(params: {
    id: string;
    adminUserId: string;
    reason?: string | null;
    onlyOrphans?: boolean;
    expectedReferencesToken?: string | null;
  }) {
    const assetId = (params.id ?? "").trim();
    if (!assetId) throw new NotFoundException("Not found.");
    const reason = (params.reason ?? "").trim() || null;
    if (!reason) throw new BadRequestException("Reason is required.");

    const a = await this.prisma.mediaAsset.findUnique({
      where: { id: assetId },
    });
    if (!a) throw new NotFoundException("Not found.");
    if (a.deletedAt) {
      return { success: true, alreadyDeleted: true };
    }

    if (params.expectedReferencesToken) {
      const current =
        (await this.references.resolveAllReferences([a.r2Key])).get(a.r2Key) ??
        emptyAssetRefs();
      if (referencesToken(current) !== params.expectedReferencesToken) {
        throw new ConflictException({
          message:
            "This media's references changed since you reviewed it. Review it again before deleting.",
          error: "references_changed",
        });
      }
    }

    if (params.onlyOrphans) {
      const refs = (await this.references.resolveAllReferences([a.r2Key])).get(
        a.r2Key,
      )!;
      if (refs.primaryType !== "orphan") {
        throw new BadRequestException(
          "This media is now in use and is no longer an orphan. Refresh media review before deleting.",
        );
      }
    }

    // Recheck on deletion, not just when the review list was loaded. Bulk deletion
    // uses this same path, so stale orphan selections cannot erase publication media.
    const publicationRefs = (
      await this.references.resolvePublicationReferences([a.r2Key])
    ).get(a.r2Key)!;
    if (
      publicationRefs.announcements.length ||
      publicationRefs.newsletters.length ||
      publicationRefs.emailDeliveries.length
    ) {
      throw new BadRequestException(
        "This media is still used by an announcement, newsletter, or retained email. Sent email images must remain available.",
      );
    }

    const now = new Date();
    const r2Key = a.r2Key;
    const fullUrl = this.storage.publicUrlForKey(r2Key);

    const affected = await this.prisma.$transaction(async (tx) => {
      // ── Tombstone the asset index row ──────────────────────────────────────
      await tx.mediaAsset.update({
        where: { id: a.id },
        data: {
          deletedAt: now,
          deletedByAdminId: params.adminUserId,
          deleteReason: reason,
        },
      });

      if (isProtectedChannelKey(r2Key))
        await tx.groupChannelUpload.deleteMany({
          where: { OR: [{ sourceKey: r2Key }, { r2Key }] },
        });

      // Prevent future "same file" uploads from reusing this tombstoned key.
      await tx.mediaContentHash.deleteMany({ where: { r2Key } });
      await tx.mediaUploadGrant.deleteMany({
        where: { OR: [{ r2Key }, { thumbnailR2Key: r2Key }] },
      });
      await tx.mediaSearchNote.deleteMany({ where: { r2Key } });

      // ── PostMedia: tombstone rows where this is the main asset ─────────────
      const postMediaDirect = await tx.postMedia.findMany({
        where: { r2Key, source: "upload" },
        select: { id: true, postId: true },
      });
      if (postMediaDirect.length) {
        await tx.postMedia.updateMany({
          where: { r2Key, source: "upload" },
          data: {
            deletedAt: now,
            deletedByAdminId: params.adminUserId,
            deletedReason: reason,
          },
        });
      }

      // ── PostMedia: null out thumbnail where this is a poster frame ─────────
      const { count: postMediaThumbnailCount } = await tx.postMedia.updateMany({
        where: { thumbnailR2Key: r2Key },
        data: { thumbnailR2Key: null },
      });

      // Keep stable media identity and ownership; canonical DTOs resolve the asset
      // tombstone and remove every unusable URL instead of dropping the attachment.
      const messageMedia = await tx.messageMedia.findMany({
        where: { source: "upload", OR: [{ r2Key }, { thumbnailR2Key: r2Key }] },
        select: {
          r2Key: true,
          thumbnailR2Key: true,
          messageId: true,
          message: {
            select: {
              conversation: {
                select: {
                  groupChannel: { select: { id: true, groupId: true } },
                },
              },
            },
          },
        },
      });
      const messageMediaCount = messageMedia.filter(
        (media) => media.r2Key === r2Key,
      ).length;
      const messageMediaThumbnailCount = messageMedia.filter(
        (media) => media.thumbnailR2Key === r2Key,
      ).length;

      await tx.avatarVideoUpload.updateMany({
        where: {
          OR: [{ sourceKey: r2Key }, { videoKey: r2Key }, { posterKey: r2Key }],
        },
        data: { status: "cancelled" },
      });
      // ── User avatar / banner ───────────────────────────────────────────────
      const users = await tx.user.findMany({
        where: {
          OR: [
            { avatarKey: r2Key },
            { avatarVideoKey: r2Key },
            { bannerKey: r2Key },
          ],
        },
        select: {
          ...USER_REF_SELECT,
          avatarKey: true,
          avatarVideoKey: true,
          avatarVideoDurationMs: true,
          bannerKey: true,
        },
      });
      const invalidatedUsers: Array<{ id: string; username: string | null }> =
        [];
      for (const u of users) {
        const data: Prisma.UserUpdateInput = {};
        if (u.avatarKey === r2Key || u.avatarVideoKey === r2Key) {
          data.avatarKey = null;
          data.avatarVideoKey = null;
          data.avatarVideoDurationMs = null;
          data.avatarRevision = { increment: 1 };
          data.avatarUpdatedAt = now;
        }
        if (u.bannerKey === r2Key) {
          data.bannerKey = null;
          data.bannerUpdatedAt = now;
        }
        if (Object.keys(data).length) {
          await tx.user.update({ where: { id: u.id }, data });
          invalidatedUsers.push({ id: u.id, username: u.username ?? null });
        }
      }

      // ── CommunityGroup avatar / cover (URL, raw key, or URL containing key) ─
      const groupUrlOrKey = [...(fullUrl ? [fullUrl] : []), r2Key];
      const groupsHit = await tx.communityGroup.findMany({
        where: {
          OR: [
            { avatarImageUrl: { in: groupUrlOrKey } },
            { coverImageUrl: { in: groupUrlOrKey } },
            { avatarImageUrl: { contains: r2Key } },
            { coverImageUrl: { contains: r2Key } },
          ],
        },
        select: { id: true, avatarImageUrl: true, coverImageUrl: true },
        take: 50,
      });
      let groupCount = 0;
      for (const g of groupsHit) {
        const data: Prisma.CommunityGroupUpdateInput = {};
        if (
          g.avatarImageUrl &&
          (g.avatarImageUrl === fullUrl ||
            g.avatarImageUrl === r2Key ||
            g.avatarImageUrl.includes(r2Key))
        ) {
          data.avatarImageUrl = null;
        }
        if (
          g.coverImageUrl &&
          (g.coverImageUrl === fullUrl ||
            g.coverImageUrl === r2Key ||
            g.coverImageUrl.includes(r2Key))
        ) {
          data.coverImageUrl = null;
        }
        if (Object.keys(data).length) {
          await tx.communityGroup.update({ where: { id: g.id }, data });
          groupCount += 1;
        }
      }

      const crewsHit = await tx.crew.findMany({
        where: {
          OR: [
            { avatarImageUrl: { in: groupUrlOrKey } },
            { coverImageUrl: { in: groupUrlOrKey } },
            { avatarImageUrl: { contains: r2Key } },
            { coverImageUrl: { contains: r2Key } },
          ],
        },
        select: { id: true, avatarImageUrl: true, coverImageUrl: true },
        take: 50,
      });
      let crewCount = 0;
      for (const c of crewsHit) {
        const data: Prisma.CrewUpdateInput = {};
        if (
          c.avatarImageUrl &&
          (c.avatarImageUrl === fullUrl ||
            c.avatarImageUrl === r2Key ||
            c.avatarImageUrl.includes(r2Key))
        ) {
          data.avatarImageUrl = null;
        }
        if (
          c.coverImageUrl &&
          (c.coverImageUrl === fullUrl ||
            c.coverImageUrl === r2Key ||
            c.coverImageUrl.includes(r2Key))
        ) {
          data.coverImageUrl = null;
        }
        if (Object.keys(data).length) {
          await tx.crew.update({ where: { id: c.id }, data });
          crewCount += 1;
        }
      }

      // ── PostPollOption image ───────────────────────────────────────────────
      const { count: pollOptionCount } = await tx.postPollOption.updateMany({
        where: { imageR2Key: r2Key },
        data: { imageR2Key: null },
      });

      // ── Article cover thumbnail ────────────────────────────────────────────
      const { count: articleThumbCount } = await tx.article.updateMany({
        where: { thumbnailR2Key: r2Key },
        data: { thumbnailR2Key: null },
      });

      // ── Article TipTap body embeds (inline article-media) ──────────────────
      const articlesWithBody = await tx.article.findMany({
        where: { body: { contains: r2Key } },
        select: { id: true, body: true },
      });
      let articleInlineCount = 0;
      for (const art of articlesWithBody) {
        const scrubbed = scrubKeyFromArticleBody(art.body, r2Key);
        if (!scrubbed.changed) continue;
        await tx.article.update({
          where: { id: art.id },
          data: { body: scrubbed.body },
        });
        articleInlineCount += 1;
      }

      return {
        postMediaCount: postMediaDirect.length,
        postMediaThumbnailCount,
        messageMediaCount,
        messageMediaThumbnailCount,
        userCount: users.length,
        groupCount,
        crewCount,
        pollOptionCount,
        articleCount: articleThumbCount + articleInlineCount,
        articleThumbCount,
        articleInlineCount,
        invalidatedUsers,
        changedMessages: messageMedia,
      };
    });

    const { invalidatedUsers, changedMessages, ...affectedCounts } = affected;
    for (const media of new Map(
      changedMessages.map((media) => [media.messageId, media]),
    ).values()) {
      const channel = media.message.conversation.groupChannel;
      try {
        if (channel)
          await this.channelMessages.publishMediaChange(
            channel.groupId,
            channel.id,
            media.messageId,
          );
        else await this.messagesRealtime.rebroadcastMessage(media.messageId);
      } catch {
        this.logger.warn(
          `Could not broadcast media deletion for message ${media.messageId}; HTTP reads remain redacted.`,
        );
      }
    }
    for (const u of invalidatedUsers) {
      await this.publicProfileCache.invalidateForUser(u);
    }

    // ── Hard-delete from R2 ────────────────────────────────────────────────
    const { s3 } = this.storage.requireR2();
    try {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: this.storage.bucketForKey(r2Key),
          Key: r2Key,
        }),
      );
      await this.prisma.mediaAsset.update({
        where: { id: a.id },
        data: { r2DeletedAt: new Date() },
      });
      return {
        success: true,
        alreadyDeleted: false,
        r2Deleted: true,
        ...affectedCounts,
      };
    } catch (e: unknown) {
      return {
        success: true,
        alreadyDeleted: false,
        r2Deleted: false,
        error: String(e instanceof Error ? e.message : e),
        ...affectedCounts,
      };
    }
  }

  async list(params: {
    limit: number;
    cursor: string | null;
    q?: string | null;
    showDeleted?: boolean;
    onlyOrphans?: boolean;
    sync?: boolean;
    kind?: "all" | "image" | "video" | null;
  }) {
    const take = clampLimit(params.limit, { default: 30, max: 100 });
    const showDeleted = Boolean(params.showDeleted);
    const onlyOrphans = Boolean(params.onlyOrphans);
    const q = (params.q ?? "").trim();
    const sync = Boolean(params.sync);
    const kindFilter = params.kind ?? "all";

    if (sync) {
      await this.sync.syncSome({ maxPagesPerPrefix: 2 });
    }

    const decoded = decodeCursor(params.cursor);
    const cursorLm = decoded ? new Date(decoded.lm) : null;
    const cursorId = decoded ? decoded.id : null;

    const kindWhere: Prisma.MediaAssetWhereInput =
      kindFilter === "image"
        ? { kind: { in: ["image", "gif"] } }
        : kindFilter === "video"
          ? { kind: "video" }
          : {};

    const where: Prisma.MediaAssetWhereInput = {
      ...(showDeleted ? {} : { deletedAt: null }),
      ...(q ? { r2Key: { contains: q, mode: "insensitive" } } : {}),
      ...kindWhere,
    };

    const out: Array<Record<string, string | null>> = [];
    let scannedThrough: { r2LastModified: Date; id: string } | null = null;
    let scanCursor = decoded
      ? { lm: cursorLm as Date, id: cursorId as string }
      : null;

    for (let pass = 0; pass < 4 && out.length < take; pass++) {
      const page = await this.prisma.mediaAsset.findMany({
        where: {
          AND: [
            where,
            ...(scanCursor
              ? [
                  {
                    OR: [
                      { r2LastModified: { lt: scanCursor.lm } },
                      {
                        r2LastModified: scanCursor.lm,
                        id: { lt: scanCursor.id },
                      },
                    ],
                  } as Prisma.MediaAssetWhereInput,
                ]
              : []),
          ],
        },
        orderBy: [{ r2LastModified: "desc" }, { id: "desc" }],
        take: take + 50,
      });

      if (!page.length) break;

      const keys = page.map((x) => x.r2Key);
      const refsMap = await this.references.resolveAllReferences(keys);

      for (const a of page) {
        scannedThrough = {
          r2LastModified: a.r2LastModified ?? a.createdAt,
          id: a.id,
        };
        const refs = refsMap.get(a.r2Key) ?? emptyAssetRefs();
        const { primaryType } = refs;
        if (onlyOrphans && primaryType !== "orphan") continue;

        const postRef = refs.posts[0];
        const userRef = refs.users[0];
        const groupRef = refs.groups[0];
        const crewRef = refs.crews[0];
        const pollRef = refs.polls[0];
        const articleRef = refs.articles[0];
        const msgRef = refs.messages[0];
        const upload = refs.channelUploads[0];
        const grant = refs.uploadGrants[0];

        out.push({
          id: a.id,
          r2Key: a.r2Key,
          kind: a.kind ?? null,
          lastModified: (a.r2LastModified ?? a.createdAt).toISOString(),
          publicUrl: this.storage.publicUrlForKey(a.deletedAt ? null : a.r2Key),
          deletedAt: a.deletedAt ? a.deletedAt.toISOString() : null,
          belongsToSummary: primaryType,
          // Post (backward compat fields preserved)
          postId: postRef?.postId ?? null,
          authorUsername: postRef?.authorUsername ?? null,
          // User (backward compat fields preserved)
          userId: userRef?.userId ?? null,
          profileUsername: userRef?.username ?? null,
          // New fields
          groupId:
            groupRef?.groupId ?? msgRef?.groupId ?? upload?.groupId ?? null,
          groupName:
            groupRef?.name ?? msgRef?.groupName ?? upload?.groupName ?? null,
          groupSlug:
            groupRef?.slug ?? msgRef?.groupSlug ?? upload?.groupSlug ?? null,
          channelId: msgRef?.channelId ?? upload?.channelId ?? null,
          channelName: msgRef?.channelName ?? upload?.channelName ?? null,
          channelPrivacy: msgRef?.channelPrivacy ?? null,
          uploaderUsername:
            msgRef?.senderUsername ??
            upload?.username ??
            grant?.username ??
            null,
          uploaderId:
            msgRef?.senderId ?? upload?.userId ?? grant?.userId ?? null,
          crewId: crewRef?.crewId ?? null,
          crewName: crewRef?.name ?? null,
          crewSlug: crewRef?.slug ?? null,
          pollPostId: pollRef?.postId ?? null,
          articleId: articleRef?.articleId ?? null,
          articleSlug: articleRef?.slug ?? null,
          messageId: msgRef?.messageId ?? null,
          announcementId: refs.announcements[0]?.id ?? null,
          newsletterId: refs.newsletters[0]?.id ?? null,
        });
        if (out.length >= take) break;
      }

      const last = page[page.length - 1];
      if (!last) break;
      scanCursor = { lm: last.r2LastModified ?? last.createdAt, id: last.id };
      if (page.length < take + 50) break;
    }

    const nextCursor =
      out.length >= take && scannedThrough
        ? encodeCursor({
            lm: scannedThrough.r2LastModified.toISOString(),
            id: scannedThrough.id,
          })
        : null;

    return { items: out, nextCursor };
  }
}
