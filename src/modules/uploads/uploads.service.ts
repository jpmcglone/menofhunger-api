import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { imageSize } from 'image-size';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { toUserDto } from '../../common/dto';
import type { PostMediaKind } from '@prisma/client';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_BANNER_BYTES = 8 * 1024 * 1024; // 8MB
const MAX_POST_MEDIA_BYTES = 12 * 1024 * 1024; // 12MB per attachment
// Phone videos are often large; keep duration cap but allow realistic file sizes.
const MAX_POST_VIDEO_BYTES = 300 * 1024 * 1024; // 300MB per video
const MAX_POST_VIDEO_DURATION_SECONDS = 5 * 60; // 5 minutes
const MAX_POST_VIDEO_WIDTH = 2560; // 1440p (landscape)
const MAX_POST_VIDEO_HEIGHT = 1440;
const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_POST_MEDIA_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  // iOS commonly uploads .mov as video/quicktime
  'video/quicktime',
  // Common in browsers / some Android encoders
  'video/webm',
  // Some devices label MP4 variants as m4v
  'video/x-m4v',
]);
const ALLOWED_THUMBNAIL_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BANNER_ASPECT_RATIO = 3; // 3:1
const BANNER_ASPECT_TOLERANCE = 0.03; // +/- 3%
const MIN_BANNER_WIDTH = 600;
const MIN_BANNER_HEIGHT = 200;
// NOTE: we intentionally avoid "banner" in object paths because ad-blockers often block URLs containing it.
const COVER_OBJECT_PREFIX = 'covers';

function extForContentType(contentType: string) {
  if (contentType === 'image/jpeg') return 'jpg';
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/gif') return 'gif';
  if (contentType === 'video/mp4') return 'mp4';
  if (contentType === 'video/quicktime') return 'mov';
  if (contentType === 'video/webm') return 'webm';
  if (contentType === 'video/x-m4v') return 'm4v';
  return null;
}

function isVideoContentType(contentType: string) {
  const ct = (contentType ?? '').trim().toLowerCase();
  return ct === 'video/mp4' || ct === 'video/quicktime' || ct === 'video/webm' || ct === 'video/x-m4v';
}

async function streamToBuffer(stream: any, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    // Node.js Readable supports async iteration.
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      total += buf.length;
      if (total > maxBytes) {
        // Best effort: stop the stream early.
        if (typeof stream?.destroy === 'function') stream.destroy();
        throw new BadRequestException('Uploaded file is too large.');
      }
    }
  } catch (e) {
    // Propagate known errors.
    throw e;
  }
  return Buffer.concat(chunks, total);
}

@Injectable()
export class UploadsService {
  private readonly s3: S3Client | null;
  private readonly bucket: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly publicProfileCache: PublicProfileCacheService<any>,
  ) {
    const r2 = this.appConfig.r2();
    if (!r2) {
      this.s3 = null;
      this.bucket = null;
      return;
    }

    this.bucket = r2.bucket;
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
      },
    });
  }

  private requireR2() {
    if (!this.s3 || !this.bucket) {
      throw new ServiceUnavailableException('Uploads are not configured yet.');
    }
    return { s3: this.s3, bucket: this.bucket };
  }

  private objectKeyPrefix() {
    // Keep prod keys stable; segregate dev/staging keys to avoid collisions.
    return this.appConfig.isProd() ? '' : 'dev/';
  }

  async initAvatarUpload(userId: string, contentType: string) {
    const { s3, bucket } = this.requireR2();

    const ct = contentType.trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(ct)) {
      throw new BadRequestException('Unsupported image type. Please upload a JPG, PNG, or WebP.');
    }
    const ext = extForContentType(ct);
    if (!ext) throw new BadRequestException('Unsupported image type.');

    const key = `${this.objectKeyPrefix()}avatars/${userId}/${randomUUID()}.${ext}`;

    // Give uploads enough time for slower networks (especially on mobile).
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: ct,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
      { expiresIn: 300 },
    );

    return {
      key,
      uploadUrl,
      headers: {
        'Content-Type': ct,
      },
      maxBytes: MAX_AVATAR_BYTES,
    };
  }

  async initBannerUpload(userId: string, contentType: string) {
    const { s3, bucket } = this.requireR2();

    const ct = contentType.trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(ct)) {
      throw new BadRequestException('Unsupported image type. Please upload a JPG, PNG, or WebP.');
    }
    const ext = extForContentType(ct);
    if (!ext) throw new BadRequestException('Unsupported image type.');

    const key = `${this.objectKeyPrefix()}${COVER_OBJECT_PREFIX}/${userId}/${randomUUID()}.${ext}`;

    // Give uploads enough time for slower networks (especially on mobile).
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: ct,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
      { expiresIn: 300 },
    );

    return {
      key,
      uploadUrl,
      headers: {
        'Content-Type': ct,
      },
      maxBytes: MAX_BANNER_BYTES,
      aspectRatio: '3:1',
    };
  }

  async initPostMediaUpload(
    userId: string,
    contentType: string,
    opts?: { contentHash?: string; purpose?: 'post' | 'thumbnail' },
  ) {
    const { s3, bucket } = this.requireR2();
    const ct = contentType.trim().toLowerCase();
    const purpose = opts?.purpose ?? 'post';

    if (purpose === 'thumbnail') {
      if (!ALLOWED_THUMBNAIL_CONTENT_TYPES.has(ct)) {
        throw new BadRequestException('Thumbnail must be JPG, PNG, or WebP.');
      }
    } else {
      if (!ALLOWED_POST_MEDIA_CONTENT_TYPES.has(ct)) {
        throw new BadRequestException(
          'Unsupported media type. Please upload a JPG, PNG, WebP, GIF, or a video (MP4, MOV, WebM).',
        );
      }
      if (isVideoContentType(ct)) {
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { premium: true } });
        if (!user?.premium) {
          throw new ForbiddenException('Video uploads are for premium members only.');
        }
      }
    }

    const contentHash = opts?.contentHash?.trim().toLowerCase();
    if (contentHash && purpose === 'post') {
      const existing = await this.prisma.mediaContentHash.findUnique({ where: { contentHash } });
      if (existing) {
        return {
          key: existing.r2Key,
          skipUpload: true,
          headers: { 'Content-Type': ct },
          maxBytes: existing.kind === 'video' ? MAX_POST_VIDEO_BYTES : MAX_POST_MEDIA_BYTES,
        };
      }
    }

    const ext = extForContentType(ct);
    if (!ext) throw new BadRequestException('Unsupported media type.');

    const prefix = this.objectKeyPrefix();
    const subdir =
      purpose === 'thumbnail' ? 'thumbnails' : isVideoContentType(ct) ? 'videos' : 'images';
    const key = `${prefix}uploads/${userId}/${subdir}/${randomUUID()}.${ext}`;

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: ct,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
      { expiresIn: 300 },
    );

    const maxBytes = isVideoContentType(ct) ? MAX_POST_VIDEO_BYTES : MAX_POST_MEDIA_BYTES;
    return {
      key,
      uploadUrl,
      headers: { 'Content-Type': ct },
      maxBytes,
    };
  }

  async commitAvatarUpload(userId: string, key: string) {
    const { s3, bucket } = this.requireR2();

    const cleaned = (key ?? '').trim();
    const expectedPrefix = `${this.objectKeyPrefix()}avatars/${userId}/`;
    if (!cleaned.startsWith(expectedPrefix)) {
      throw new BadRequestException('Invalid avatar key.');
    }

    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: cleaned }));
    const contentType = (head.ContentType ?? '').toLowerCase();
    const size = head.ContentLength ?? 0;

    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      // best-effort cleanup
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      throw new BadRequestException('Uploaded file is not a supported image.');
    }

    if (size > MAX_AVATAR_BYTES) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      throw new BadRequestException('Avatar is too large.');
    }

    const now = new Date();

    const existing = await this.prisma.user.findUnique({ where: { id: userId } });
    const oldKey = existing?.avatarKey ?? null;

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        avatarKey: cleaned,
        avatarUpdatedAt: now,
      },
    });

    this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });

    if (oldKey && oldKey !== cleaned) {
      // Best-effort deletion; don't fail the request if it errors.
      // In dev/staging, never delete non-dev keys (avoid nuking prod objects in shared buckets).
      const prefix = this.objectKeyPrefix();
      const canDelete = prefix === '' || oldKey.startsWith(prefix);
      if (canDelete) {
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey })).catch(() => undefined);
      }
    }

    return { user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
  }

  async commitBannerUpload(userId: string, key: string) {
    const { s3, bucket } = this.requireR2();

    const cleaned = (key ?? '').trim();
    const prefix = this.objectKeyPrefix();
    // Backwards compatible: accept legacy "banners/" keys, but new uploads use "covers/".
    const allowedPrefixes = [
      `${prefix}${COVER_OBJECT_PREFIX}/${userId}/`,
      `${prefix}banners/${userId}/`,
    ];
    if (!allowedPrefixes.some((p) => cleaned.startsWith(p))) {
      throw new BadRequestException('Invalid banner key.');
    }

    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: cleaned }));
    const contentType = (head.ContentType ?? '').toLowerCase();
    const size = head.ContentLength ?? 0;

    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      throw new BadRequestException('Uploaded file is not a supported image.');
    }

    if (size > MAX_BANNER_BYTES) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      throw new BadRequestException('Banner is too large.');
    }

    // Validate dimensions server-side (not just client cropping).
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: cleaned }));
      const body = (obj as any).Body;
      if (!body) throw new BadRequestException('Unable to read uploaded banner.');
      const buf = await streamToBuffer(body, MAX_BANNER_BYTES);
      const dims = imageSize(buf);
      const w = (dims as any).width ?? 0;
      const h = (dims as any).height ?? 0;
      if (!w || !h) throw new BadRequestException('Unable to read banner dimensions.');
      if (w < MIN_BANNER_WIDTH || h < MIN_BANNER_HEIGHT) {
        throw new BadRequestException(`Banner is too small. Minimum is ${MIN_BANNER_WIDTH}×${MIN_BANNER_HEIGHT}.`);
      }
      const ratio = w / h;
      if (Math.abs(ratio - BANNER_ASPECT_RATIO) > BANNER_ASPECT_TOLERANCE) {
        throw new BadRequestException('Banner must be 3:1 (for example, 1500×500).');
      }
    } catch (err) {
      // If validation fails, cleanup the uploaded object.
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('Invalid banner image.');
    }

    const now = new Date();
    const existing = await this.prisma.user.findUnique({ where: { id: userId } });
    const oldKey = existing?.bannerKey ?? null;

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        bannerKey: cleaned,
        bannerUpdatedAt: now,
      },
    });

    this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });

    if (oldKey && oldKey !== cleaned) {
      const prefix = this.objectKeyPrefix();
      const canDelete = prefix === '' || oldKey.startsWith(prefix);
      if (canDelete) {
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey })).catch(() => undefined);
      }
    }

    return { user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
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
    const { s3, bucket } = this.requireR2();
    const cleaned = (body.key ?? '').trim();
    const prefix = this.objectKeyPrefix();
    const imagesPrefix = `${prefix}uploads/${userId}/images/`;
    const videosPrefix = `${prefix}uploads/${userId}/videos/`;
    const thumbnailsPrefix = `${prefix}uploads/${userId}/thumbnails/`;

    // Reuse path: key was returned from init with skipUpload: true (existing in MediaContentHash).
    // Check this first so we accept keys under any user path when reusing by content hash.
    const existingByKey = await this.prisma.mediaContentHash.findFirst({ where: { r2Key: cleaned } });
    if (existingByKey) {
      // For reused content hashes, return the real content-type from object metadata
      // (the same key could be video/mp4, video/quicktime, etc).
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: cleaned }));
      const contentType = (head.ContentType ?? '').toLowerCase();
      if (!ALLOWED_POST_MEDIA_CONTENT_TYPES.has(contentType)) {
        throw new BadRequestException('Uploaded file is not a supported image, GIF, or video.');
      }

      const thumbnailKey =
        typeof body.thumbnailKey === 'string' && body.thumbnailKey.trim().startsWith(thumbnailsPrefix)
          ? body.thumbnailKey.trim()
          : undefined;

      if (existingByKey.kind === 'video') {
        const w = existingByKey.width ?? null;
        const h = existingByKey.height ?? null;
        const d = existingByKey.durationSeconds ?? null;
        if (d != null && d > MAX_POST_VIDEO_DURATION_SECONDS) {
          throw new BadRequestException('Video must be 5 minutes or shorter.');
        }
        if (w != null && h != null && (w > MAX_POST_VIDEO_WIDTH || h > MAX_POST_VIDEO_HEIGHT)) {
          throw new BadRequestException('Video must be 1440p or smaller.');
        }
      }

      return {
        key: cleaned,
        contentType,
        kind: existingByKey.kind as 'image' | 'gif' | 'video',
        width: existingByKey.width ?? undefined,
        height: existingByKey.height ?? undefined,
        durationSeconds: existingByKey.durationSeconds ?? undefined,
        thumbnailKey: thumbnailKey ?? undefined,
      };
    }

    if (!cleaned.startsWith(imagesPrefix) && !cleaned.startsWith(videosPrefix)) {
      throw new BadRequestException('Invalid media key.');
    }

    const isVideo = cleaned.startsWith(videosPrefix);

    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: cleaned }));
    const contentType = (head.ContentType ?? '').toLowerCase();
    const size = head.ContentLength ?? 0;

    if (!ALLOWED_POST_MEDIA_CONTENT_TYPES.has(contentType)) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      throw new BadRequestException('Uploaded file is not a supported image, GIF, or video.');
    }

    const maxBytes = isVideo ? MAX_POST_VIDEO_BYTES : MAX_POST_MEDIA_BYTES;
    if (size > maxBytes) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      throw new BadRequestException('Uploaded file is too large.');
    }

    let width: number | null = null;
    let height: number | null = null;
    let durationSeconds: number | null = null;

    if (isVideo) {
      width =
        typeof body.width === 'number' && Number.isFinite(body.width) ? Math.max(1, Math.floor(body.width)) : null;
      height =
        typeof body.height === 'number' && Number.isFinite(body.height) ? Math.max(1, Math.floor(body.height)) : null;
      durationSeconds =
        typeof body.durationSeconds === 'number' && Number.isFinite(body.durationSeconds) && body.durationSeconds >= 0
          ? Math.floor(body.durationSeconds)
          : null;

      if (width == null || height == null || durationSeconds == null) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
        throw new BadRequestException('Video uploads must include width, height, and durationSeconds.');
      }
      if (durationSeconds > MAX_POST_VIDEO_DURATION_SECONDS) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
        throw new BadRequestException('Video must be 5 minutes or shorter.');
      }
      if (width > MAX_POST_VIDEO_WIDTH || height > MAX_POST_VIDEO_HEIGHT) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
        throw new BadRequestException('Video must be 1440p or smaller.');
      }
    } else {
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: cleaned }));
        const streamBody = (obj as any).Body;
        if (streamBody) {
          const buf = await streamToBuffer(streamBody, MAX_POST_MEDIA_BYTES);
          const dims = imageSize(buf);
          const w = (dims as any).width ?? 0;
          const h = (dims as any).height ?? 0;
          if (w && h) {
            width = Math.max(1, Math.floor(w));
            height = Math.max(1, Math.floor(h));
          }
        }
      } catch {
        // ignore; dims optional
      }
    }

    const kind: PostMediaKind = isVideo ? 'video' : contentType === 'image/gif' ? 'gif' : 'image';

    const contentHash = (body.contentHash ?? '').trim().toLowerCase();
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
          bytes: size,
        },
        update: {},
      });
    }

    const thumbnailKey =
      typeof body.thumbnailKey === 'string' && body.thumbnailKey.trim().startsWith(thumbnailsPrefix)
        ? body.thumbnailKey.trim()
        : undefined;

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
}

