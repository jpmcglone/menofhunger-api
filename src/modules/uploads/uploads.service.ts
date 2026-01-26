import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { toUserDto } from '../users/user.dto';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function extForContentType(contentType: string) {
  if (contentType === 'image/jpeg') return 'jpg';
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  return null;
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

  async initAvatarUpload(userId: string, contentType: string) {
    const { s3, bucket } = this.requireR2();

    const ct = contentType.trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(ct)) {
      throw new BadRequestException('Unsupported image type. Please upload a JPG, PNG, or WebP.');
    }
    const ext = extForContentType(ct);
    if (!ext) throw new BadRequestException('Unsupported image type.');

    const key = `avatars/${userId}/${randomUUID()}.${ext}`;

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: ct,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
      { expiresIn: 60 },
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

  async commitAvatarUpload(userId: string, key: string) {
    const { s3, bucket } = this.requireR2();

    const cleaned = (key ?? '').trim();
    if (!cleaned.startsWith(`avatars/${userId}/`)) {
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
      s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: oldKey })).catch(() => undefined);
    }

    return { user: toUserDto(updated) };
  }
}

