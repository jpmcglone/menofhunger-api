import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import type { MediaUploadGrant, Prisma, PostMediaKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { UploadsStorageService } from "./uploads-storage.service";
import {
  ALLOWED_THUMBNAIL_CONTENT_TYPES,
  MAX_POST_MEDIA_BYTES,
  extForContentType,
  streamToBuffer,
} from "./uploads.constants";
import type { MessageMediaInput } from "../messages/messages.models";

export const UPLOAD_GRANT_RETENTION_MS = 7 * 86400_000;
const unavailable = () =>
  new BadRequestException(
    "This upload is no longer available. Attach the file again.",
  );
export function uploadedMediaKind(contentType: string): PostMediaKind {
  return contentType.startsWith("video/")
    ? "video"
    : contentType.startsWith("audio/")
      ? "audio"
      : contentType === "image/gif"
        ? "gif"
        : "image";
}

@Injectable()
export class UploadGrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: UploadsStorageService,
  ) {}

  async pending(userId: string, r2Key: string, contentType: string) {
    const data = {
      contentType,
      kind: uploadedMediaKind(contentType),
      committedAt: null,
      expiresAt: new Date(Date.now() + UPLOAD_GRANT_RETENTION_MS),
      etag: null,
      thumbnailR2Key: null,
    };
    await this.prisma.mediaUploadGrant.upsert({
      where: { userId_r2Key: { userId, r2Key } },
      create: { userId, r2Key, ...data },
      update: { expiresAt: data.expiresAt },
    });
  }

  async assertCommitAccess(
    userId: string,
    r2Key: string,
    contentHash?: string,
  ) {
    const prefix = `${this.storage.objectKeyPrefix()}uploads/${userId}/`;
    // Own-namespace init/PUT may have happened before this grant table was deployed.
    if (r2Key.startsWith(prefix)) return;
    const grant = await this.prisma.mediaUploadGrant.findUnique({
      where: { userId_r2Key: { userId, r2Key } },
    });
    if (grant && grant.expiresAt > new Date()) return;
    if (contentHash) {
      const dedup = await this.prisma.mediaContentHash.findUnique({
        where: { contentHash: contentHash.trim().toLowerCase() },
      });
      if (dedup?.r2Key === r2Key) return;
    }
    throw unavailable();
  }

  private async liveHead(r2Key: string) {
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { r2Key },
      select: { deletedAt: true, r2DeletedAt: true },
    });
    if (asset?.deletedAt || asset?.r2DeletedAt) throw unavailable();
    const { s3, bucket } = this.storage.requireR2();
    try {
      return await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: r2Key }),
      );
    } catch {
      throw unavailable();
    }
  }

  async committed(
    userId: string,
    r2Key: string,
    metadata: {
      width?: number | null;
      height?: number | null;
      durationSeconds?: number | null;
      thumbnailR2Key?: string | null;
    },
  ) {
    const head = await this.liveHead(r2Key);
    const contentType = (head.ContentType ?? "").toLowerCase();
    if (!head.ETag || !head.ContentLength) throw unavailable();
    const data = {
      committedAt: new Date(),
      expiresAt: new Date(Date.now() + UPLOAD_GRANT_RETENTION_MS),
      contentType,
      kind: uploadedMediaKind(contentType),
      bytes: head.ContentLength,
      etag: head.ETag,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      durationSeconds: metadata.durationSeconds ?? null,
      thumbnailR2Key: metadata.thumbnailR2Key ?? null,
    };
    await this.prisma.mediaUploadGrant.upsert({
      where: { userId_r2Key: { userId, r2Key } },
      create: { userId, r2Key, ...data },
      update: data,
    });
  }

  /** Existing video clients PUT a thumbnail and commit it with the parent upload. */
  async commitThumbnail(userId: string, r2Key: string) {
    await this.assertCommitAccess(userId, r2Key);
    const head = await this.liveHead(r2Key);
    const contentType = (head.ContentType ?? "").toLowerCase();
    if (
      !ALLOWED_THUMBNAIL_CONTENT_TYPES.has(contentType) ||
      !head.ContentLength ||
      head.ContentLength > MAX_POST_MEDIA_BYTES
    )
      throw unavailable();
    const { s3, bucket } = this.storage.requireR2();
    const image = await this.storage.getImageInfoAndNormalizeJpegIfNeeded({
      s3,
      bucket,
      key: r2Key,
      contentType,
      maxBytes: MAX_POST_MEDIA_BYTES,
      cacheControl: "public, max-age=31536000, immutable",
    });
    await this.committed(userId, r2Key, image);
  }

  private matches(
    head: { ETag?: string; ContentLength?: number; ContentType?: string },
    grant: MediaUploadGrant,
  ) {
    return (
      head.ETag === grant.etag &&
      head.ContentLength === grant.bytes &&
      (head.ContentType ?? "").toLowerCase() === grant.contentType
    );
  }

  /** Every destination is server-selected and is never a presigned PUT target. */
  private async snapshot(
    userId: string,
    grant: MediaUploadGrant,
    thumbnailR2Key: string | null,
  ) {
    const immutablePrefix = `${this.storage.objectKeyPrefix()}uploads/${userId}/message-media/`;
    if (grant.r2Key.startsWith(immutablePrefix)) return grant;
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          grant.r2Key,
          grant.etag,
          grant.committedAt?.toISOString(),
        ]),
      )
      .digest("hex");
    const r2Key = `${immutablePrefix}${digest}.${extForContentType(grant.contentType)}`;
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { r2Key },
      select: { deletedAt: true, r2DeletedAt: true },
    });
    if (asset?.deletedAt || asset?.r2DeletedAt) throw unavailable();
    const existing = await this.prisma.mediaUploadGrant.findUnique({
      where: { userId_r2Key: { userId, r2Key } },
    });
    if (existing?.committedAt && existing.r2Key === r2Key) {
      const head = await this.liveHead(r2Key);
      if (!this.matches(head, existing)) throw unavailable();
      await this.pending(userId, r2Key, existing.contentType);
      return existing;
    }
    // Keep failed or rolled-back sends reviewable for the bounded draft retention
    // window. This durable pending record intentionally lives outside the send tx.
    await this.pending(userId, r2Key, grant.contentType);
    const { s3, bucket } = this.storage.requireR2();
    try {
      const copied = await s3.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: r2Key,
          CopySource: `${bucket}/${encodeURIComponent(grant.r2Key).replace(/%2F/g, "/")}`,
          CopySourceIfMatch: grant.etag!,
          MetadataDirective: "REPLACE",
          ContentType: grant.contentType,
          CacheControl: "public, max-age=31536000, immutable",
        }),
      );
      const head = await this.liveHead(r2Key);
      if (
        !head.ETag ||
        head.ETag !== copied.CopyObjectResult?.ETag ||
        head.ContentLength !== grant.bytes ||
        (head.ContentType ?? "").toLowerCase() !== grant.contentType ||
        !head.ContentLength ||
        head.ContentLength > MAX_POST_MEDIA_BYTES
      )
        throw unavailable();
      // Inspect the immutable bytes, so a source replacement during the legacy
      // commit's normalization/HEAD window cannot authorize unreadable media.
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: r2Key,
          IfMatch: head.ETag,
        }),
      );
      if (!object.Body) throw unavailable();
      const dimensions = imageSize(
        await streamToBuffer(object.Body, MAX_POST_MEDIA_BYTES),
      );
      if (
        !dimensions.width ||
        !dimensions.height ||
        dimensions.type !== extForContentType(grant.contentType)
      )
        throw unavailable();
      const data = {
        committedAt: new Date(),
        expiresAt: new Date(Date.now() + UPLOAD_GRANT_RETENTION_MS),
        contentType: grant.contentType,
        kind: grant.kind,
        bytes: head.ContentLength,
        etag: head.ETag,
        width: dimensions.width,
        height: dimensions.height,
        durationSeconds: null,
        thumbnailR2Key,
      };
      return await this.prisma.mediaUploadGrant.upsert({
        where: { userId_r2Key: { userId, r2Key } },
        create: { userId, r2Key, ...data },
        update: data,
      });
    } catch {
      throw unavailable();
    }
  }

  async photo(
    userId: string,
    media: Extract<MessageMediaInput, { source: "upload" }>,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const grant = await db.mediaUploadGrant.findUnique({
      where: { userId_r2Key: { userId, r2Key: media.r2Key } },
    });
    const asset = await db.mediaAsset.findUnique({
      where: { r2Key: media.r2Key },
      select: { deletedAt: true, r2DeletedAt: true },
    });
    if (
      !grant?.committedAt ||
      grant.expiresAt <= new Date() ||
      asset?.deletedAt ||
      asset?.r2DeletedAt ||
      grant.kind !== media.kind ||
      !["image", "gif"].includes(grant.kind) ||
      (media.thumbnailR2Key ?? null) !== grant.thumbnailR2Key
    )
      throw unavailable();
    const head = await this.liveHead(media.r2Key);
    if (!this.matches(head, grant)) throw unavailable();
    let thumbnailR2Key: string | null = null;
    if (grant.thumbnailR2Key) {
      const thumbnail = await db.mediaUploadGrant.findUnique({
        where: { userId_r2Key: { userId, r2Key: grant.thumbnailR2Key } },
      });
      if (
        !thumbnail?.committedAt ||
        thumbnail.expiresAt <= new Date() ||
        thumbnail.kind !== "image" ||
        !this.matches(await this.liveHead(thumbnail.r2Key), thumbnail)
      )
        throw unavailable();
      thumbnailR2Key = (await this.snapshot(userId, thumbnail, null)).r2Key;
    }
    const canonical = await this.snapshot(userId, grant, thumbnailR2Key);
    return {
      ...media,
      r2Key: canonical.r2Key,
      width: canonical.width,
      height: canonical.height,
      durationSeconds: canonical.durationSeconds,
      thumbnailR2Key: canonical.thumbnailR2Key,
    };
  }
}
