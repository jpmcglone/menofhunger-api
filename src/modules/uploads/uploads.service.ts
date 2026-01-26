import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { imageSize } from 'image-size';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { toUserDto } from '../users/user.dto';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_BANNER_BYTES = 8 * 1024 * 1024; // 8MB
const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
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
  return null;
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

    if (oldKey && oldKey !== cleaned) {
      // Best-effort deletion; don't fail the request if it errors.
      // In dev/staging, never delete non-dev keys (avoid nuking prod objects in shared buckets).
      const prefix = this.objectKeyPrefix();
      const canDelete = prefix === '' || oldKey.startsWith(prefix);
      if (canDelete) {
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey })).catch(() => undefined);
      }
    }

    return { user: toUserDto(updated) };
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

    if (oldKey && oldKey !== cleaned) {
      const prefix = this.objectKeyPrefix();
      const canDelete = prefix === '' || oldKey.startsWith(prefix);
      if (canDelete) {
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey })).catch(() => undefined);
      }
    }

    return { user: toUserDto(updated) };
  }
}

