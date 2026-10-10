import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { AppConfigService } from "../app/app-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { AdminImageReviewStorageService } from "./admin-image-review-storage.service";
import { AdminImageReferencesService } from "./admin-image-review-references.service";
import { AdminImageReviewActionsService } from "./admin-image-review-actions.service";
import {
  emptyAssetRefs,
  referencesToken,
  type AssetRefs,
} from "./admin-image-review.types";

function parseBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

@Injectable()
export class AdminImageReviewService {
  private readonly logger = new Logger(AdminImageReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfigService,
    private readonly storage: AdminImageReviewStorageService,
    private readonly references: AdminImageReferencesService,
    private readonly actions: AdminImageReviewActionsService,
  ) {}

  /** Snapshot every owned upload, including unused uploads and video derivatives. */
  async accountErasureKeys(userId: string): Promise<string[]> {
    if (!userId || /[/\\]/.test(userId))
      throw new BadRequestException("Invalid account.");
    const { s3, bucket } = this.storage.requireR2();
    const keys = new Set<string>();
    const grants = await this.prisma.mediaUploadGrant.findMany({
      where: { userId },
      select: { r2Key: true, thumbnailR2Key: true },
    });
    for (const grant of grants)
      for (const key of [grant.r2Key, grant.thumbnailR2Key])
        if (key) keys.add(key);
    for (const area of [
      "uploads",
      "avatars",
      "covers",
      "banners",
      "article-thumbnails",
      "article-media",
      "announcement-images",
      ...(this.cfg.channelMediaBucket() ? ["channel-uploads"] : []),
    ]) {
      let continuation: string | undefined;
      do {
        const page = await s3.send(
          new ListObjectsV2Command({
            Bucket:
              area === "channel-uploads"
                ? this.storage.bucketForKey("channel-uploads/")
                : bucket,
            Prefix: `${this.storage.objectKeyPrefix()}${area}/${userId}/`,
            ContinuationToken: continuation,
          }),
        );
        for (const item of page.Contents ?? [])
          if (item.Key) keys.add(item.Key);
        continuation = page.IsTruncated
          ? page.NextContinuationToken
          : undefined;
      } while (continuation);
    }
    return [...keys];
  }

  /** Reuse the central ownership resolver; never remove another member's referenced media. */
  async eraseUnreferencedAccountMedia(keys: string[]): Promise<void> {
    if (!keys.length) return;
    const { s3 } = this.storage.requireR2();
    for (let start = 0; start < keys.length; start += 100) {
      const batch = keys.slice(start, start + 100);
      const references = await this.references.resolveAllReferences(batch);
      for (const key of batch) {
        if (references.get(key)?.primaryType !== "orphan") continue;
        // S3 deletion is idempotent. Keep the durable receipt until every operation succeeds.
        await s3.send(
          new DeleteObjectCommand({
            Bucket: this.storage.bucketForKey(key),
            Key: key,
          }),
        );
        await this.prisma.mediaContentHash.deleteMany({
          where: { r2Key: key },
        });
        await this.prisma.mediaUploadGrant.deleteMany({
          where: { OR: [{ r2Key: key }, { thumbnailR2Key: key }] },
        });
        await this.prisma.mediaSearchNote.deleteMany({ where: { r2Key: key } });
        await this.prisma.mediaAsset.deleteMany({ where: { r2Key: key } });
      }
    }
  }

  /**
   * ============================================================
   * REFERENCE REGISTRY — the single source of truth for every
   * DB table that stores an R2 object key.
   *
   * When you add a new upload surface you MUST add it here, or:
   *   • orphan detection will false-positive on those assets
   *   • admin deletes will leave dangling references in the DB
   *
   * Current holders:
   *   PostMedia.r2Key              (post images / GIFs / videos)
   *   PostMedia.thumbnailR2Key     (video poster frames for posts)
   *   MessageMedia.r2Key           (DM / crew-wall images)
   *   MessageMedia.thumbnailR2Key  (DM / crew-wall video thumbnails)
   *   User.avatarKey               (profile photo or video poster)
   *   User.avatarVideoKey          (current profile avatar MP4; independent of upload bookkeeping)
   *   AvatarVideoUpload.sourceKey/videoKey/posterKey (retained avatar upload jobs)
   *   User.bannerKey               (profile banner)
   *   CommunityGroup.avatarImageUrl  (full URL — group square avatar)
   *   CommunityGroup.coverImageUrl   (full URL — group wide banner)
   *   Crew.avatarImageUrl            (full URL — crew square avatar)
   *   Crew.coverImageUrl             (full URL — crew wide banner)
   *   PostPollOption.imageR2Key    (poll option images)
   *   Article.thumbnailR2Key       (article cover thumbnails)
   *   Announcement.imageKey       (notices and ads, including drafts/archived)
   *   Newsletter.imageKey/bodyJson (covers and embeds, including sent history)
   *   Article.body (TipTap JSON)   (inline article-media/ images via attrs.src URL)
   * ============================================================
   */
  async resolveAllReferences(keys: string[]): Promise<Map<string, AssetRefs>> {
    return this.references.resolveAllReferences(keys);
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
    return this.actions.list(params);
  }

  async getById(id: string) {
    const assetId = (id ?? "").trim();
    if (!assetId) throw new NotFoundException("Not found.");
    const a = await this.prisma.mediaAsset.findUnique({
      where: { id: assetId },
    });
    if (!a) throw new NotFoundException("Not found.");

    const refsMap = await this.references.resolveAllReferences([a.r2Key]);
    const refs = refsMap.get(a.r2Key) ?? emptyAssetRefs();

    const publicUrl = this.storage.publicUrlForKey(
      a.deletedAt ? null : a.r2Key,
    );

    return {
      asset: {
        id: a.id,
        r2Key: a.r2Key,
        lastModified: (a.r2LastModified ?? a.createdAt).toISOString(),
        bytes: a.bytes ?? null,
        contentType: a.contentType ?? null,
        kind: a.kind ?? null,
        width: a.width ?? null,
        height: a.height ?? null,
        deletedAt: a.deletedAt ? a.deletedAt.toISOString() : null,
        deleteReason: a.deleteReason ?? null,
        r2DeletedAt: a.r2DeletedAt ? a.r2DeletedAt.toISOString() : null,
        publicUrl,
        primaryType: refs.primaryType,
        referencesToken: referencesToken(refs),
      },
      references: {
        posts: refs.posts.map((p) => ({
          postMediaId: p.postMediaId,
          postId: p.postId,
          postCreatedAt: p.postCreatedAt,
          postVisibility: p.postVisibility,
          author: { id: p.authorId, username: p.authorUsername },
          deletedAt: p.deletedAt,
          isThumbnail: p.isThumbnail,
        })),
        messages: refs.messages,
        channelUploads: refs.channelUploads,
        uploadGrants: refs.uploadGrants,
        users: refs.users.map((u) => ({
          id: u.userId,
          username: u.username,
          name: u.name,
          premium: u.premium,
          premiumPlus: u.premiumPlus,
          verifiedStatus: u.verifiedStatus,
          isAvatar: u.isAvatar,
          isBanner: u.isBanner,
        })),
        groups: refs.groups,
        crews: refs.crews,
        polls: refs.polls,
        articles: refs.articles,
        announcements: refs.announcements,
        newsletters: refs.newsletters,
        emailDeliveries: refs.emailDeliveries,
      },
    };
  }

  async deleteById(params: {
    id: string;
    adminUserId: string;
    reason?: string | null;
    onlyOrphans?: boolean;
    expectedReferencesToken?: string | null;
  }) {
    return this.actions.deleteById(params);
  }

  /**
   * Bulk-delete up to 200 assets in one admin action. Skips already-deleted
   * assets silently; collects errors per-id so one bad id doesn't abort the batch.
   */
  async deleteManyByIds(params: {
    ids: string[];
    adminUserId: string;
    reason: string;
    onlyOrphans?: boolean;
  }): Promise<{
    deleted: number;
    skipped: number;
    errors: Array<{ id: string; message: string }>;
  }> {
    const ids = [
      ...new Set(params.ids.map((id) => id.trim()).filter(Boolean)),
    ].slice(0, 200);
    let deleted = 0;
    let skipped = 0;
    const errors: Array<{ id: string; message: string }> = [];

    for (const id of ids) {
      try {
        const result = await this.deleteById({
          id,
          adminUserId: params.adminUserId,
          reason: params.reason,
          onlyOrphans: params.onlyOrphans,
        });
        if (result.alreadyDeleted) skipped += 1;
        else deleted += 1;
      } catch (err) {
        errors.push({
          id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.log(
      `[media-review] bulk-delete admin=${params.adminUserId} requested=${ids.length} deleted=${deleted} skipped=${skipped} errors=${errors.length}`,
    );
    return { deleted, skipped, errors };
  }

  parseBool(v: unknown) {
    return parseBool(v);
  }
}
export type { AssetRefs } from "./admin-image-review.types";
export type { AssetPrimaryType } from "./admin-image-review.types";
export type { MessageRef } from "./admin-image-review.types";
export type { PostRef } from "./admin-image-review.types";
export type { UserRef } from "./admin-image-review.types";
