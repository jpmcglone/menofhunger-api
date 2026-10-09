import { Injectable, NotFoundException } from '@nestjs/common';
import { UploadsStorageService } from './uploads-storage.service';
import { PrismaService } from '../prisma/prisma.service';


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
import {
  ALLOWED_CONTENT_TYPES,
  MAX_ARTICLE_THUMBNAIL_BYTES,
  MAX_ARTICLE_MEDIA_BYTES,
  ARTICLE_THUMBNAIL_ASPECT_RATIO,
  ARTICLE_THUMBNAIL_ASPECT_TOLERANCE,
  MIN_ARTICLE_THUMBNAIL_WIDTH,
  extForContentType,
} from "./uploads.constants";

@Injectable()
export class UploadsArticleAssetsService {
  constructor(
    private readonly storage: UploadsStorageService,
    private readonly prisma: PrismaService,
  ) {}

  async initArticleThumbnailUpload(userId: string,
    contentType: string,
  ) {
    const { s3, bucket } = this.storage.requireR2();
    const ct = contentType.trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(ct)) {
      throw new BadRequestException(
        "Unsupported image type. Please upload a JPG, PNG, or WebP.",
      );
    }
    const ext = extForContentType(ct);
    if (!ext) throw new BadRequestException("Unsupported image type.");

    const key = `${this.storage.objectKeyPrefix()}article-thumbnails/${userId}/${randomUUID()}.${ext}`;
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
    return {
      key,
      uploadUrl,
      headers: { "Content-Type": ct },
      maxBytes: MAX_ARTICLE_THUMBNAIL_BYTES,
      aspectRatio: "16:9",
    };
  }

  async commitArticleThumbnailUpload(userId: string,
    key: string,
  ) {
    const { s3, bucket } = this.storage.requireR2();
    const cleaned = (key ?? "").trim();
    const expectedPrefix = `${this.storage.objectKeyPrefix()}article-thumbnails/${userId}/`;
    if (!cleaned.startsWith(expectedPrefix))
      throw new BadRequestException("Invalid article thumbnail key.");

    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: cleaned }),
    );
    const contentType = (head.ContentType ?? "").toLowerCase();
    const size = head.ContentLength ?? 0;

    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      throw new BadRequestException("Uploaded file is not a supported image.");
    }
    if (size > MAX_ARTICLE_THUMBNAIL_BYTES) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      throw new BadRequestException("Thumbnail is too large (max 8MB).");
    }

    try {
      const info = await this.storage.getImageInfoAndNormalizeJpegIfNeeded({
        s3,
        bucket,
        key: cleaned,
        contentType,
        maxBytes: MAX_ARTICLE_THUMBNAIL_BYTES,
        cacheControl: "public, max-age=31536000, immutable",
      });
      const w = info.width ?? 0;
      const h = info.height ?? 0;
      if (!w || !h)
        throw new BadRequestException("Unable to read image dimensions.");
      if (w < MIN_ARTICLE_THUMBNAIL_WIDTH) {
        throw new BadRequestException(
          `Thumbnail is too small (min ${MIN_ARTICLE_THUMBNAIL_WIDTH}px wide).`,
        );
      }
      const ratio = w / h;
      if (
        Math.abs(ratio - ARTICLE_THUMBNAIL_ASPECT_RATIO) >
        ARTICLE_THUMBNAIL_ASPECT_TOLERANCE
      ) {
        throw new BadRequestException(
          "Thumbnail must be 16:9 (for example, 1200×675).",
        );
      }
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException("Invalid thumbnail image.");
    }

    return { key: cleaned };
  }

  async initAnnouncementImageUpload(userId: string,
    contentType: string,
  ) {
    await this.assertSiteAdmin(userId);
    const { s3, bucket } = this.storage.requireR2();
    const ct = contentType.trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(ct)) {
      throw new BadRequestException(
        "Unsupported image type. Please upload a JPG, PNG, or WebP.",
      );
    }
    const ext = extForContentType(ct);
    if (!ext) throw new BadRequestException("Unsupported image type.");

    const key = `${this.storage.objectKeyPrefix()}announcement-images/${userId}/${randomUUID()}.${ext}`;
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
    return {
      key,
      uploadUrl,
      headers: { "Content-Type": ct },
      maxBytes: MAX_ARTICLE_THUMBNAIL_BYTES,
      aspectRatio: "16:9",
    };
  }

  async commitAnnouncementImageUpload(userId: string,
    key: string,
  ) {
    await this.assertSiteAdmin(userId);
    const { s3, bucket } = this.storage.requireR2();
    const cleaned = (key ?? "").trim();
    const expectedPrefix = `${this.storage.objectKeyPrefix()}announcement-images/${userId}/`;
    if (!cleaned.startsWith(expectedPrefix))
      throw new BadRequestException("Invalid announcement image key.");

    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: cleaned }),
    );
    const contentType = (head.ContentType ?? "").toLowerCase();
    const size = head.ContentLength ?? 0;

    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      throw new BadRequestException("Uploaded file is not a supported image.");
    }
    if (size > MAX_ARTICLE_THUMBNAIL_BYTES) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      throw new BadRequestException("Image is too large (max 8MB).");
    }

    try {
      const info = await this.storage.getImageInfoAndNormalizeJpegIfNeeded({
        s3,
        bucket,
        key: cleaned,
        contentType,
        maxBytes: MAX_ARTICLE_THUMBNAIL_BYTES,
        cacheControl: "public, max-age=31536000, immutable",
      });
      const w = info.width ?? 0;
      const h = info.height ?? 0;
      if (!w || !h)
        throw new BadRequestException("Unable to read image dimensions.");
      if (w < MIN_ARTICLE_THUMBNAIL_WIDTH) {
        throw new BadRequestException(
          `Image is too small (min ${MIN_ARTICLE_THUMBNAIL_WIDTH}px wide).`,
        );
      }
      const ratio = w / h;
      if (
        Math.abs(ratio - ARTICLE_THUMBNAIL_ASPECT_RATIO) >
        ARTICLE_THUMBNAIL_ASPECT_TOLERANCE
      ) {
        throw new BadRequestException(
          "Image must be 16:9 (for example, 1200×675).",
        );
      }
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException("Invalid announcement image.");
    }

    return { key: cleaned };
  }

  async initArticleMediaUpload(userId: string,
    contentType: string,
  ) {
    const { s3, bucket } = this.storage.requireR2();
    const ct = contentType.trim().toLowerCase();
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowed.has(ct)) {
      throw new BadRequestException(
        "Article inline images must be JPG, PNG, or WebP.",
      );
    }
    const ext = extForContentType(ct);
    if (!ext) throw new BadRequestException("Unsupported image type.");

    const key = `${this.storage.objectKeyPrefix()}article-media/${userId}/${randomUUID()}.${ext}`;
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
    return {
      key,
      uploadUrl,
      headers: { "Content-Type": ct },
      maxBytes: MAX_ARTICLE_MEDIA_BYTES,
    };
  }

  async commitArticleMediaUpload(userId: string,
    key: string,
  ) {
    const { s3, bucket } = this.storage.requireR2();
    const cleaned = (key ?? "").trim();
    const expectedPrefix = `${this.storage.objectKeyPrefix()}article-media/${userId}/`;
    if (!cleaned.startsWith(expectedPrefix))
      throw new BadRequestException("Invalid article media key.");

    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: cleaned }),
    );
    const contentType = (head.ContentType ?? "").toLowerCase();
    const size = head.ContentLength ?? 0;
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);

    if (!allowed.has(contentType)) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      throw new BadRequestException(
        "Uploaded file is not a supported image type.",
      );
    }
    if (size > MAX_ARTICLE_MEDIA_BYTES) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      throw new BadRequestException("Image is too large (max 12MB).");
    }

    if (contentType === "image/jpeg") {
      await this.storage.getImageInfoAndNormalizeJpegIfNeeded({
        s3,
        bucket,
        key: cleaned,
        contentType,
        maxBytes: MAX_ARTICLE_MEDIA_BYTES,
        cacheControl: "public, max-age=31536000, immutable",
      });
    }

    return { key: cleaned };
  }

  async assertSiteAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { siteAdmin: true },
    });
    if (!user?.siteAdmin) throw new NotFoundException();
  }
}






