import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { imageSize } from 'image-size';
import sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { toUserDto } from '../../common/dto';
import type { PostMediaKind } from '@prisma/client';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { UsersPublicRealtimeService } from '../users/users-public-realtime.service';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_BANNER_BYTES = 8 * 1024 * 1024; // 8MB
const MAX_POST_MEDIA_BYTES = 12 * 1024 * 1024; // 12MB per attachment
// Video uploads are premium-only; premium+ gets higher caps.
// NOTE: We don't transcode yet, but mobile devices increasingly produce large 4K files.
// Use a practical cap that avoids "upload forever then fail" while still allowing modern devices.
const MAX_POST_VIDEO_BYTES_PREMIUM = 250 * 1024 * 1024; // 250MB
const MAX_POST_VIDEO_BYTES_PREMIUM_PLUS = 500 * 1024 * 1024; // 500MB
const MAX_POST_VIDEO_DURATION_SECONDS_PREMIUM = 5 * 60; // 5 minutes
const MAX_POST_VIDEO_DURATION_SECONDS_PREMIUM_PLUS = 15 * 60; // 15 minutes
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

function isNotFoundLikeS3Error(err: unknown): boolean {
  // AWS SDK v3 errors vary by runtime; check common signals.
  const anyErr = err as any;
  const code = String(anyErr?.name ?? anyErr?.Code ?? anyErr?.code ?? '').toLowerCase();
  const status = Number(anyErr?.$metadata?.httpStatusCode ?? anyErr?.$response?.httpResponse?.statusCode ?? NaN);
  return code.includes('notfound') || code.includes('nosuchkey') || status === 404;
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
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly usersPublicRealtime: UsersPublicRealtimeService,
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

  private async videoLimitsForUserOrThrow(userId: string): Promise<{ maxBytes: number; maxDurationSeconds: number }> {
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
    throw new ForbiddenException('Video uploads are for premium members only.');
  }

  /**
   * Some phone photos are stored "sideways" with EXIF orientation metadata.
   * Browsers often display them correctly, but link unfurlers (iMessage/OG crawlers) may not.
   * Normalize JPEGs by applying orientation to pixels and stripping EXIF.
   */
  private async normalizeJpegOrientationIfNeeded(params: {
    s3: S3Client;
    bucket: string;
    key: string;
    maxBytes: number;
    cacheControl: string;
  }): Promise<{ width: number | null; height: number | null; bytes: number; didNormalize: boolean }> {
    const { s3, bucket, key, maxBytes, cacheControl } = params;

    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = (obj as any).Body;
    if (!body) throw new BadRequestException('Unable to read uploaded image.');
    const buf = await streamToBuffer(body, maxBytes);

    // Check if EXIF orientation requires normalization.
    let meta: sharp.Metadata;
    try {
      meta = await sharp(buf, { failOn: 'none' }).metadata();
    } catch {
      // If sharp can't read metadata, fall back to using the original bytes.
      const dims = imageSize(buf);
      const w = (dims as any).width ?? null;
      const h = (dims as any).height ?? null;
      return {
        width: typeof w === 'number' ? Math.max(1, Math.floor(w)) : null,
        height: typeof h === 'number' ? Math.max(1, Math.floor(h)) : null,
        bytes: buf.length,
        didNormalize: false,
      };
    }

    const orientation = typeof meta.orientation === 'number' ? meta.orientation : null;
    if (!orientation || orientation === 1) {
      const w = typeof meta.width === 'number' ? meta.width : null;
      const h = typeof meta.height === 'number' ? meta.height : null;
      return {
        width: w && w > 0 ? w : null,
        height: h && h > 0 ? h : null,
        bytes: buf.length,
        didNormalize: false,
      };
    }

    // Apply orientation to pixels and strip metadata by re-encoding.
    const rotated = await sharp(buf, { failOn: 'none' })
      .rotate()
      .jpeg({ quality: 92 })
      .toBuffer({ resolveWithObject: true });

    const out = rotated.data;
    const w = rotated.info?.width ?? null;
    const h = rotated.info?.height ?? null;
    if (out.length > maxBytes) {
      throw new BadRequestException('Uploaded file is too large.');
    }

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: out,
        ContentType: 'image/jpeg',
        CacheControl: cacheControl,
      }),
    );

    return {
      width: typeof w === 'number' && w > 0 ? w : null,
      height: typeof h === 'number' && h > 0 ? h : null,
      bytes: out.length,
      didNormalize: true,
    };
  }

  private async getImageInfoAndNormalizeJpegIfNeeded(params: {
    s3: S3Client;
    bucket: string;
    key: string;
    contentType: string;
    maxBytes: number;
    cacheControl: string;
  }): Promise<{ width: number | null; height: number | null; bytes: number; didNormalize: boolean }> {
    const { s3, bucket, key, contentType, maxBytes, cacheControl } = params;
    const ct = (contentType ?? '').trim().toLowerCase();

    if (ct === 'image/jpeg') {
      return await this.normalizeJpegOrientationIfNeeded({ s3, bucket, key, maxBytes, cacheControl });
    }

    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = (obj as any).Body;
    if (!body) throw new BadRequestException('Unable to read uploaded image.');
    const buf = await streamToBuffer(body, maxBytes);
    const dims = imageSize(buf);
    const w = (dims as any).width ?? null;
    const h = (dims as any).height ?? null;
    return {
      width: typeof w === 'number' ? Math.max(1, Math.floor(w)) : null,
      height: typeof h === 'number' ? Math.max(1, Math.floor(h)) : null,
      bytes: buf.length,
      didNormalize: false,
    };
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
      // Give large mobile uploads a bigger window to start (hashing/metadata extraction can be slow).
      { expiresIn: isVideoContentType(ct) ? 900 : 300 },
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
        await this.videoLimitsForUserOrThrow(userId);
      }
    }

    const contentHash = opts?.contentHash?.trim().toLowerCase();
    if (contentHash && purpose === 'post') {
      const existing = await this.prisma.mediaContentHash.findUnique({ where: { contentHash } });
      if (existing) {
        // Never reuse media that has been admin-deleted (tombstoned), even if the bytes match.
        // Also, if the backing object is missing in R2, fall back to a fresh upload.
        const asset = await this.prisma.mediaAsset.findUnique({ where: { r2Key: existing.r2Key } }).catch(() => null);
        if (asset?.deletedAt || asset?.r2DeletedAt) {
          // Best-effort cleanup so future uploads won't try to reuse this tombstoned key.
          this.prisma.mediaContentHash.delete({ where: { contentHash } }).catch(() => undefined);
        } else {
          try {
            // Ensure the object still exists in R2 before instructing the client to skip upload.
            await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: existing.r2Key }));
            return {
              key: existing.r2Key,
              skipUpload: true,
              headers: { 'Content-Type': ct },
              maxBytes: existing.kind === 'video' ? (await this.videoLimitsForUserOrThrow(userId)).maxBytes : MAX_POST_MEDIA_BYTES,
            };
          } catch (err) {
            // If the object is missing (or we can't verify), upload again.
            if (isNotFoundLikeS3Error(err)) {
              this.prisma.mediaContentHash.delete({ where: { contentHash } }).catch(() => undefined);
            }
          }
        }
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

    const maxBytes = isVideoContentType(ct)
      ? (await this.videoLimitsForUserOrThrow(userId)).maxBytes
      : MAX_POST_MEDIA_BYTES;
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

    // Normalize JPEG orientation so avatars render correctly in all contexts (including metadata previews).
    if (contentType === 'image/jpeg') {
      await this.getImageInfoAndNormalizeJpegIfNeeded({
        s3,
        bucket,
        key: cleaned,
        contentType,
        maxBytes: MAX_AVATAR_BYTES,
        cacheControl: 'public, max-age=31536000, immutable',
      }).catch(() => undefined);
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

    await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
    void this.usersPublicRealtime.emitPublicProfileUpdated(updated.id);
    this.usersMeRealtime.emitMeUpdatedFromUser(updated, 'avatar_changed');

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
      const info = await this.getImageInfoAndNormalizeJpegIfNeeded({
        s3,
        bucket,
        key: cleaned,
        contentType,
        maxBytes: MAX_BANNER_BYTES,
        cacheControl: 'public, max-age=31536000, immutable',
      });
      const w = info.width ?? 0;
      const h = info.height ?? 0;
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

    await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
    void this.usersPublicRealtime.emitPublicProfileUpdated(updated.id);
    this.usersMeRealtime.emitMeUpdatedFromUser(updated, 'banner_changed');

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
      const size = head.ContentLength ?? 0;
      if (!ALLOWED_POST_MEDIA_CONTENT_TYPES.has(contentType)) {
        throw new BadRequestException('Uploaded file is not a supported image, GIF, or video.');
      }

      const thumbnailKey =
        typeof body.thumbnailKey === 'string' && body.thumbnailKey.trim().startsWith(thumbnailsPrefix)
          ? body.thumbnailKey.trim()
          : undefined;

      if (existingByKey.kind === 'video') {
        const limits = await this.videoLimitsForUserOrThrow(userId);
        const w = existingByKey.width ?? null;
        const h = existingByKey.height ?? null;
        const d = existingByKey.durationSeconds ?? null;
        if (size > limits.maxBytes) {
          throw new BadRequestException('Uploaded file is too large.');
        }
        if (d != null && d > limits.maxDurationSeconds) {
          const mins = Math.round(limits.maxDurationSeconds / 60);
          throw new BadRequestException(`Video must be ${mins} minutes or shorter.`);
        }
        // No resolution caps (MB + duration only).
        void w;
        void h;
      }

      // Normalize EXIF orientation for JPEGs so link unfurlers (iMessage) render correctly.
      let width = existingByKey.width ?? null;
      let height = existingByKey.height ?? null;
      let bytes = typeof existingByKey.bytes === 'number' ? existingByKey.bytes : size;
      if (existingByKey.kind === 'image') {
        const normalized = await this.getImageInfoAndNormalizeJpegIfNeeded({
          s3,
          bucket,
          key: cleaned,
          contentType,
          maxBytes: MAX_POST_MEDIA_BYTES,
          cacheControl: 'public, max-age=31536000, immutable',
        });
        width = normalized.width ?? width;
        height = normalized.height ?? height;
        bytes = normalized.bytes ?? bytes;
        if (normalized.didNormalize) {
          await this.prisma.mediaContentHash.update({
            where: { contentHash: existingByKey.contentHash },
            data: {
              width: width ?? undefined,
              height: height ?? undefined,
              bytes,
            },
          }).catch(() => undefined);
        }
      }

      return {
        key: cleaned,
        contentType,
        kind: existingByKey.kind as 'image' | 'gif' | 'video',
        width: width ?? undefined,
        height: height ?? undefined,
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

    const videoLimits = isVideo ? await this.videoLimitsForUserOrThrow(userId) : null;
    const maxBytes = isVideo ? videoLimits!.maxBytes : MAX_POST_MEDIA_BYTES;
    if (size > maxBytes) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      throw new BadRequestException('Uploaded file is too large.');
    }

    let width: number | null = null;
    let height: number | null = null;
    let durationSeconds: number | null = null;
    let finalBytes = size;

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
      if (durationSeconds > (videoLimits?.maxDurationSeconds ?? MAX_POST_VIDEO_DURATION_SECONDS_PREMIUM)) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
        const mins = Math.round((videoLimits?.maxDurationSeconds ?? MAX_POST_VIDEO_DURATION_SECONDS_PREMIUM) / 60);
        throw new BadRequestException(`Video must be ${mins} minutes or shorter.`);
      }
    } else {
      try {
        const normalized = await this.getImageInfoAndNormalizeJpegIfNeeded({
            s3,
            bucket,
            key: cleaned,
          contentType,
            maxBytes: MAX_POST_MEDIA_BYTES,
            cacheControl: 'public, max-age=31536000, immutable',
          });
        width = normalized.width;
        height = normalized.height;
        finalBytes = normalized.bytes;
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
          bytes: finalBytes,
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

