import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { toUserDto } from '../../common/dto';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { UsersPublicRealtimeService } from '../users/users-public-realtime.service';
import { MAX_AVATAR_BYTES, MAX_BANNER_BYTES, ALLOWED_CONTENT_TYPES, BANNER_ASPECT_RATIO, MIN_BANNER_WIDTH, MIN_BANNER_HEIGHT, COVER_OBJECT_PREFIX, extForContentType, isVideoContentType } from './uploads.constants';
import { UploadsStorageService } from './uploads-storage.service';
import { UploadsPostMediaService } from './uploads-post-media.service';
import { UploadsArticleAssetsService } from './uploads-article-assets.service';

@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly storage: UploadsStorageService,
    private readonly publicProfileCache: PublicProfileCacheService<any>,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly usersPublicRealtime: UsersPublicRealtimeService,
    private readonly postMedia: UploadsPostMediaService,
    private readonly articleAssets: UploadsArticleAssetsService,
  ) {}

  async initAvatarUpload(userId: string, contentType: string) {
    const { s3, bucket } = this.storage.requireR2();

    const ct = contentType.trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(ct)) {
      throw new BadRequestException('Unsupported image type. Please upload a JPG, PNG, or WebP.');
    }
    const ext = extForContentType(ct);
    if (!ext) throw new BadRequestException('Unsupported image type.');

    const key = `${this.storage.objectKeyPrefix()}avatars/${userId}/${randomUUID()}.${ext}`;

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
    const { s3, bucket } = this.storage.requireR2();

    const ct = contentType.trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(ct)) {
      throw new BadRequestException('Unsupported image type. Please upload a JPG, PNG, or WebP.');
    }
    const ext = extForContentType(ct);
    if (!ext) throw new BadRequestException('Unsupported image type.');

    const key = `${this.storage.objectKeyPrefix()}${COVER_OBJECT_PREFIX}/${userId}/${randomUUID()}.${ext}`;

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

  async initPostMediaUpload(userId: string, contentType: string, opts?: { contentHash?: string; purpose?: 'post' | 'thumbnail' | 'group' | 'crew' | 'voicemail' }) {
    return this.postMedia.initPostMediaUpload(userId, contentType, opts);
  }

  async commitAvatarUpload(userId: string, key: string) {
    const { s3, bucket } = this.storage.requireR2();

    const cleaned = (key ?? '').trim();
    const expectedPrefix = `${this.storage.objectKeyPrefix()}avatars/${userId}/`;
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

    // Validate the decoded, orientation-normalized image for every supported format.
    try {
      const info = await this.storage.getImageInfoAndNormalizeJpegIfNeeded({
        s3, bucket, key: cleaned, contentType, maxBytes: MAX_AVATAR_BYTES,
        cacheControl: 'public, max-age=31536000, immutable',
      });
      if (!info.width || !info.height || info.width !== info.height) {
        throw new BadRequestException('Profile image must be 1:1 (square).');
      }
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: cleaned }));
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('Invalid profile image.');
    }

    const now = new Date();

    const existing = await this.prisma.user.findUnique({ where: { id: userId } });
    const oldKey = existing?.avatarKey ?? null;

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        avatarKey: cleaned,
        avatarVideoKey: null, avatarVideoDurationMs: null, avatarRevision: { increment: 1 },
        avatarUpdatedAt: now,
      },
    });

    await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
    void this.usersPublicRealtime.emitPublicProfileUpdated(updated.id);
    this.usersMeRealtime.emitMeUpdatedFromUser(updated, 'avatar_changed');

    if (oldKey && oldKey !== cleaned) {
      // Best-effort deletion; don't fail the request if it errors.
      // In dev/staging, never delete non-dev keys (avoid nuking prod objects in shared buckets).
      const prefix = this.storage.objectKeyPrefix();
      const canDelete = prefix === '' || oldKey.startsWith(prefix);
      if (canDelete) {
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey })).catch(() => undefined);
      }
    }

    return { user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
  }

  async commitBannerUpload(userId: string, key: string) {
    const { s3, bucket } = this.storage.requireR2();

    const cleaned = (key ?? '').trim();
    const prefix = this.storage.objectKeyPrefix();
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
      const info = await this.storage.getImageInfoAndNormalizeJpegIfNeeded({
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
      if (w !== h * BANNER_ASPECT_RATIO) {
        throw new BadRequestException('Banner must be 3:1 (for example, 1500×500).');
      }
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
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
      const prefix = this.storage.objectKeyPrefix();
      const canDelete = prefix === '' || oldKey.startsWith(prefix);
      if (canDelete) {
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey })).catch(() => undefined);
      }
    }

    return { user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
  }

  /**
   * Clear the user's avatar. Idempotent — calling on a user with no avatar
   * still returns the current UserDto (no error, no realtime emit). When an
   * avatar existed we update the row, invalidate caches, emit the standard
   * `avatar_changed` realtime signal, and best-effort delete the old S3
   * object (subject to the same prefix safety check as commit*).
   */
  async deleteAvatarForUser(userId: string) {
    const existing = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!existing) throw new NotFoundException('User not found.');
    if (!existing.avatarKey && !existing.avatarRevision) {
      return { user: toUserDto(existing, this.appConfig.r2()?.publicBaseUrl ?? null) };
    }
    const oldKey = existing.avatarKey;
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { avatarKey: null, avatarVideoKey: null, avatarVideoDurationMs: null, avatarRevision: { increment: 1 }, avatarUpdatedAt: new Date() },
    });

    await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
    void this.usersPublicRealtime.emitPublicProfileUpdated(updated.id);
    this.usersMeRealtime.emitMeUpdatedFromUser(updated, 'avatar_changed');

    const prefix = this.storage.objectKeyPrefix();
    if (oldKey && (prefix === '' || oldKey.startsWith(prefix))) {
      try {
        const { s3, bucket } = this.storage.requireR2();
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey })).catch(() => undefined);
      } catch {
        // R2 not configured (e.g., local dev) — DB state is still cleared.
      }
    }

    return { user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
  }

  /**
   * Clear the user's banner. Mirrors {@link deleteAvatarForUser}.
   */
  async deleteBannerForUser(userId: string) {
    const existing = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!existing) throw new NotFoundException('User not found.');
    if (!existing.bannerKey) {
      return { user: toUserDto(existing, this.appConfig.r2()?.publicBaseUrl ?? null) };
    }
    const oldKey = existing.bannerKey;
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { bannerKey: null, bannerUpdatedAt: new Date() },
    });

    await this.publicProfileCache.invalidateForUser({ id: updated.id, username: updated.username ?? null });
    void this.usersPublicRealtime.emitPublicProfileUpdated(updated.id);
    this.usersMeRealtime.emitMeUpdatedFromUser(updated, 'banner_changed');

    const prefix = this.storage.objectKeyPrefix();
    if (oldKey && (prefix === '' || oldKey.startsWith(prefix))) {
      try {
        const { s3, bucket } = this.storage.requireR2();
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey })).catch(() => undefined);
      } catch {
        // R2 not configured — DB state is still cleared.
      }
    }

    return { user: toUserDto(updated, this.appConfig.r2()?.publicBaseUrl ?? null) };
  }

  async commitPostMediaUpload(userId: string, body: { key: string; contentHash?: string; thumbnailKey?: string; width?: number; height?: number; durationSeconds?: number }) {
    return this.postMedia.commitPostMediaUpload(userId, body);
  }

  // ─── Article thumbnail ─────────────────────────────────────────────────────

  async initArticleThumbnailUpload(userId: string, contentType: string) {
    return this.articleAssets.initArticleThumbnailUpload(userId, contentType);
  }

  async commitArticleThumbnailUpload(userId: string, key: string) {
    return this.articleAssets.commitArticleThumbnailUpload(userId, key);
  }

  // ─── Announcement hero (admin-only, 16:9) ────────────────────────────────

  async initAnnouncementImageUpload(userId: string, contentType: string) {
    return this.articleAssets.initAnnouncementImageUpload(userId, contentType);
  }

  async commitAnnouncementImageUpload(userId: string, key: string) {
    return this.articleAssets.commitAnnouncementImageUpload(userId, key);
  }

  // ─── Article inline media (images only) ───────────────────────────────────

  async initArticleMediaUpload(userId: string, contentType: string) {
    return this.articleAssets.initArticleMediaUpload(userId, contentType);
  }

  async commitArticleMediaUpload(userId: string, key: string) {
    return this.articleAssets.commitArticleMediaUpload(userId, key);
  }
}

