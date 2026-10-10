import { UploadGrantsService } from "./upload-grants.service";
import { ForbiddenException, Injectable } from "@nestjs/common";
import { UploadsStorageService } from "./uploads-storage.service";
import {
  MAX_POST_VIDEO_BYTES_PREMIUM,
  MAX_POST_VIDEO_BYTES_PREMIUM_PLUS,
  MAX_POST_VIDEO_DURATION_SECONDS_PREMIUM_PLUS,
} from "./uploads.constants";

import { PrismaService } from "../prisma/prisma.service";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PostMediaKind } from "@prisma/client";
import {
  MAX_POST_MEDIA_BYTES,
  MAX_POST_VIDEO_DURATION_SECONDS_PREMIUM,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_SECONDS,
  MAX_VOICEMAIL_BYTES,
  MAX_VOICEMAIL_DURATION_SECONDS,
  ALLOWED_CONTENT_TYPES,
  ALLOWED_POST_MEDIA_CONTENT_TYPES,
  ALLOWED_THUMBNAIL_CONTENT_TYPES,
  extForContentType,
  isNotFoundLikeS3Error,
  isVideoContentType,
  isAudioContentType,
} from "./uploads.constants";

@Injectable()
export class UploadsPostMediaService {
  constructor(
    private readonly storage: UploadsStorageService,
    private readonly prisma: PrismaService,
    private readonly grants: UploadGrantsService,
  ) {}

  async initPostMediaUpload(
    userId: string,
    contentType: string,
    opts?: {
      contentHash?: string;
      purpose?: "post" | "thumbnail" | "group" | "crew" | "voicemail";
    },
  ) {
    const { s3, bucket } = this.storage.requireR2();
    const ct = contentType.trim().toLowerCase();
    const purpose = opts?.purpose ?? "post";

    if (purpose === "thumbnail") {
      if (!ALLOWED_THUMBNAIL_CONTENT_TYPES.has(ct)) {
        throw new BadRequestException("Thumbnail must be JPG, PNG, or WebP.");
      }
    } else if (purpose === "group") {
      if (!ALLOWED_CONTENT_TYPES.has(ct)) {
        throw new BadRequestException(
          "Group images must be JPG, PNG, or WebP.",
        );
      }
    } else if (purpose === "crew") {
      if (!ALLOWED_CONTENT_TYPES.has(ct)) {
        throw new BadRequestException("Crew images must be JPG, PNG, or WebP.");
      }
    } else if (purpose === "voicemail") {
      if (!isVideoContentType(ct)) {
        throw new BadRequestException(
          "Voicemail must be a video (MP4, MOV, or WebM).",
        );
      }
    } else {
      if (!ALLOWED_POST_MEDIA_CONTENT_TYPES.has(ct)) {
        throw new BadRequestException(
          "Unsupported media type. Please upload a JPG, PNG, WebP, GIF, a video (MP4, MOV, WebM), or an audio note.",
        );
      }
      if (isVideoContentType(ct)) {
        await this.videoLimitsForUserOrThrow(userId);
      }
    }

    const contentHash = opts?.contentHash?.trim().toLowerCase();
    if (contentHash && purpose === "post") {
      const existing = await this.prisma.mediaContentHash.findUnique({
        where: { contentHash },
      });
      if (existing) {
        // Never reuse media that has been admin-deleted (tombstoned), even if the bytes match.
        // Also, if the backing object is missing in R2, fall back to a fresh upload.
        const asset = await this.prisma.mediaAsset
          .findUnique({ where: { r2Key: existing.r2Key } })
          .catch(() => null);
        if (asset?.deletedAt || asset?.r2DeletedAt) {
          // Best-effort cleanup so future uploads won't try to reuse this tombstoned key.
          this.prisma.mediaContentHash
            .delete({ where: { contentHash } })
            .catch(() => undefined);
        } else {
          try {
            // Ensure the object still exists in R2 before instructing the client to skip upload.
            await s3.send(
              new HeadObjectCommand({ Bucket: bucket, Key: existing.r2Key }),
            );
            await this.grants.pending(userId, existing.r2Key, ct);
            return {
              key: existing.r2Key,
              skipUpload: true,
              headers: { "Content-Type": ct },
              maxBytes:
                existing.kind === "video"
                  ? (await this.videoLimitsForUserOrThrow(userId)).maxBytes
                  : MAX_POST_MEDIA_BYTES,
            };
          } catch (err) {
            // If the object is missing (or we can't verify), upload again.
            if (isNotFoundLikeS3Error(err)) {
              this.prisma.mediaContentHash
                .delete({ where: { contentHash } })
                .catch(() => undefined);
            }
          }
        }
      }
    }

    const ext = extForContentType(ct);
    if (!ext) throw new BadRequestException("Unsupported media type.");

    const prefix = this.storage.objectKeyPrefix();
    const subdir =
      purpose === "thumbnail"
        ? "thumbnails"
        : purpose === "group"
          ? "group-images"
          : purpose === "crew"
            ? "crew-images"
            : purpose === "voicemail"
              ? "voicemail"
              : isVideoContentType(ct)
                ? "videos"
                : isAudioContentType(ct)
                  ? "audio"
                  : "images";
    const key = `${prefix}uploads/${userId}/${subdir}/${randomUUID()}.${ext}`;

    await this.grants.pending(userId, key, ct);
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: ct,
        CacheControl: "public, max-age=31536000, immutable",
      }),
      { expiresIn: 300 },
    );

    const maxBytes =
      purpose === "voicemail"
        ? MAX_VOICEMAIL_BYTES
        : isVideoContentType(ct)
          ? (await this.videoLimitsForUserOrThrow(userId)).maxBytes
          : isAudioContentType(ct)
            ? MAX_AUDIO_BYTES
            : MAX_POST_MEDIA_BYTES;
    return {
      key,
      uploadUrl,
      headers: { "Content-Type": ct },
      maxBytes,
    };
  }

  async commitPostMediaUpload(
    userId: string,
    body: {
      key: string;
      contentHash?: string;
      thumbnailKey?: string;
      width?: number;
      height?: number;
      durationSeconds?: number;
    },
  ) {
    const { s3, bucket } = this.storage.requireR2();
    const cleaned = (body.key ?? "").trim();
    await this.grants.assertCommitAccess(userId, cleaned, body.contentHash);
    const prefix = this.storage.objectKeyPrefix();
    const imagesPrefix = `${prefix}uploads/${userId}/images/`;
    const videosPrefix = `${prefix}uploads/${userId}/videos/`;
    const audioPrefix = `${prefix}uploads/${userId}/audio/`;
    const voicemailPrefix = `${prefix}uploads/${userId}/voicemail/`;
    const thumbnailsPrefix = `${prefix}uploads/${userId}/thumbnails/`;
    const groupImagesPrefix = `${prefix}uploads/${userId}/group-images/`;
    const crewImagesPrefix = `${prefix}uploads/${userId}/crew-images/`;

    // Reuse path: key was returned from init with skipUpload: true (existing in MediaContentHash).
    // Check this first so we accept keys under any user path when reusing by content hash.
    const existingByKey = await this.prisma.mediaContentHash.findFirst({
      where: { r2Key: cleaned },
    });
    if (existingByKey) {
      // For reused content hashes, return the real content-type from object metadata
      // (the same key could be video/mp4, video/quicktime, etc).
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: cleaned }),
      );
      const contentType = (head.ContentType ?? "").toLowerCase();
      const size = head.ContentLength ?? 0;
      if (!ALLOWED_POST_MEDIA_CONTENT_TYPES.has(contentType)) {
        throw new BadRequestException(
          "Uploaded file is not a supported image, GIF, or video.",
        );
      }

      const thumbnailKey =
        typeof body.thumbnailKey === "string" &&
        body.thumbnailKey.trim().startsWith(thumbnailsPrefix)
          ? body.thumbnailKey.trim()
          : undefined;

      if (existingByKey.kind === "video") {
        const limits = await this.videoLimitsForUserOrThrow(userId);
        const w = existingByKey.width ?? null;
        const h = existingByKey.height ?? null;
        const d = existingByKey.durationSeconds ?? null;
        if (size > limits.maxBytes) {
          throw new BadRequestException("Uploaded file is too large.");
        }
        if (d != null && d > limits.maxDurationSeconds) {
          const mins = Math.round(limits.maxDurationSeconds / 60);
          throw new BadRequestException(
            `Video must be ${mins} minutes or shorter.`,
          );
        }
        // No resolution caps (MB + duration only).
        void w;
        void h;
      }

      // Normalize EXIF orientation for JPEGs so link unfurlers (iMessage) render correctly.
      let width = existingByKey.width ?? null;
      let height = existingByKey.height ?? null;
      let bytes =
        typeof existingByKey.bytes === "number" ? existingByKey.bytes : size;
      if (existingByKey.kind === "image") {
        const normalized =
          await this.storage.getImageInfoAndNormalizeJpegIfNeeded({
            s3,
            bucket,
            key: cleaned,
            contentType,
            maxBytes: MAX_POST_MEDIA_BYTES,
            cacheControl: "public, max-age=31536000, immutable",
          });
        width = normalized.width ?? width;
        height = normalized.height ?? height;
        bytes = normalized.bytes ?? bytes;
        if (normalized.didNormalize) {
          await this.prisma.mediaContentHash
            .update({
              where: { contentHash: existingByKey.contentHash },
              data: {
                width: width ?? undefined,
                height: height ?? undefined,
                bytes,
              },
            })
            .catch(() => undefined);
        }
      }

      if (thumbnailKey) await this.grants.commitThumbnail(userId, thumbnailKey);
      await this.grants.committed(userId, cleaned, {
        width,
        height,
        durationSeconds: existingByKey.durationSeconds,
        thumbnailR2Key: thumbnailKey,
      });
      return {
        key: cleaned,
        contentType,
        kind: existingByKey.kind as PostMediaKind,
        width: width ?? undefined,
        height: height ?? undefined,
        durationSeconds: existingByKey.durationSeconds ?? undefined,
        thumbnailKey: thumbnailKey ?? undefined,
      };
    }

    if (
      !cleaned.startsWith(imagesPrefix) &&
      !cleaned.startsWith(videosPrefix) &&
      !cleaned.startsWith(audioPrefix) &&
      !cleaned.startsWith(voicemailPrefix) &&
      !cleaned.startsWith(groupImagesPrefix) &&
      !cleaned.startsWith(crewImagesPrefix)
    ) {
      throw new BadRequestException("Invalid media key.");
    }

    const isVoicemail = cleaned.startsWith(voicemailPrefix);
    const isVideo = cleaned.startsWith(videosPrefix) || isVoicemail;
    const isAudio = cleaned.startsWith(audioPrefix);

    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: cleaned }),
    );
    const contentType = (head.ContentType ?? "").toLowerCase();
    const size = head.ContentLength ?? 0;

    if (!ALLOWED_POST_MEDIA_CONTENT_TYPES.has(contentType)) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      throw new BadRequestException(
        "Uploaded file is not a supported image, GIF, video, or audio.",
      );
    }

    const videoLimits =
      isVideo && !isVoicemail
        ? await this.videoLimitsForUserOrThrow(userId)
        : null;
    const maxBytes = isVoicemail
      ? MAX_VOICEMAIL_BYTES
      : isVideo
        ? videoLimits!.maxBytes
        : isAudio
          ? MAX_AUDIO_BYTES
          : MAX_POST_MEDIA_BYTES;
    if (size > maxBytes) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      throw new BadRequestException("Uploaded file is too large.");
    }

    let width: number | null = null;
    let height: number | null = null;
    let durationSeconds: number | null = null;
    let finalBytes = size;

    if (isAudio) {
      durationSeconds =
        typeof body.durationSeconds === "number" &&
        Number.isFinite(body.durationSeconds) &&
        body.durationSeconds >= 0
          ? Math.floor(body.durationSeconds)
          : null;
      if (durationSeconds == null) {
        await s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }),
        );
        throw new BadRequestException(
          "Audio uploads must include durationSeconds.",
        );
      }
      if (durationSeconds > MAX_AUDIO_DURATION_SECONDS) {
        await s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }),
        );
        throw new BadRequestException(
          "Voice notes must be 2 minutes or shorter.",
        );
      }
    } else if (isVideo) {
      width =
        typeof body.width === "number" && Number.isFinite(body.width)
          ? Math.max(1, Math.floor(body.width))
          : null;
      height =
        typeof body.height === "number" && Number.isFinite(body.height)
          ? Math.max(1, Math.floor(body.height))
          : null;
      durationSeconds =
        typeof body.durationSeconds === "number" &&
        Number.isFinite(body.durationSeconds) &&
        body.durationSeconds >= 0
          ? Math.floor(body.durationSeconds)
          : null;

      if (width == null || height == null || durationSeconds == null) {
        await s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }),
        );
        throw new BadRequestException(
          "Video uploads must include width, height, and durationSeconds.",
        );
      }
      const maxDuration = isVoicemail
        ? MAX_VOICEMAIL_DURATION_SECONDS
        : (videoLimits?.maxDurationSeconds ??
          MAX_POST_VIDEO_DURATION_SECONDS_PREMIUM);
      if (durationSeconds > maxDuration) {
        await s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }),
        );
        if (isVoicemail) {
          throw new BadRequestException(
            "Video messages must be 60 seconds or shorter.",
          );
        }
        const mins = Math.round(maxDuration / 60);
        throw new BadRequestException(
          `Video must be ${mins} minutes or shorter.`,
        );
      }
    } else {
      try {
        const normalized =
          await this.storage.getImageInfoAndNormalizeJpegIfNeeded({
            s3,
            bucket,
            key: cleaned,
            contentType,
            maxBytes: MAX_POST_MEDIA_BYTES,
            cacheControl: "public, max-age=31536000, immutable",
          });
        width = normalized.width;
        height = normalized.height;
        finalBytes = normalized.bytes;
      } catch (err) {
        if (
          err instanceof ServiceUnavailableException ||
          err instanceof BadRequestException
        )
          throw err;
        // Unreadable optional dimensions do not prevent otherwise valid uploads.
      }
    }

    const kind: PostMediaKind = isAudio
      ? "audio"
      : isVideo
        ? "video"
        : contentType === "image/gif"
          ? "gif"
          : "image";

    const contentHash = (body.contentHash ?? "").trim().toLowerCase();
    if (contentHash) {
      await this.prisma.mediaContentHash.upsert({
        where: { contentHash },
        create: {
          contentHash,
          r2Key: cleaned,
          kind,
          width: width ?? undefined,
          height: height ?? undefined,
          durationSeconds: durationSeconds ?? undefined,
          bytes: finalBytes,
        },
        update: {},
      });
    }

    const thumbnailKey =
      typeof body.thumbnailKey === "string" &&
      body.thumbnailKey.trim().startsWith(thumbnailsPrefix)
        ? body.thumbnailKey.trim()
        : undefined;

    if (thumbnailKey) await this.grants.commitThumbnail(userId, thumbnailKey);
    await this.grants.committed(userId, cleaned, {
      width,
      height,
      durationSeconds,
      thumbnailR2Key: thumbnailKey,
    });
    return {
      key: cleaned,
      contentType,
      kind,
      width: width ?? undefined,
      height: height ?? undefined,
      durationSeconds: durationSeconds ?? undefined,
      thumbnailKey: thumbnailKey ?? undefined,
    };
  }

  async videoLimitsForUserOrThrow(
    userId: string,
  ): Promise<{ maxBytes: number; maxDurationSeconds: number }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premium: true, premiumPlus: true },
    });
    if (user?.premiumPlus) {
      return {
        maxBytes: MAX_POST_VIDEO_BYTES_PREMIUM_PLUS,
        maxDurationSeconds: MAX_POST_VIDEO_DURATION_SECONDS_PREMIUM_PLUS,
      };
    }
    if (user?.premium) {
      return {
        maxBytes: MAX_POST_VIDEO_BYTES_PREMIUM,
        maxDurationSeconds: MAX_POST_VIDEO_DURATION_SECONDS_PREMIUM,
      };
    }
    throw new ForbiddenException("Video uploads are for premium members only.");
  }
}
