import { ListObjectsV2Command, type ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { type PostMediaKind } from '@prisma/client';
import { AppConfigService } from '../app/app-config.service';
import { isProtectedChannelKey } from '../group-channels/channel-media.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminImageReviewStorageService } from './admin-image-review-storage.service';

function guessKindFromKey(key: string): PostMediaKind | null {
  const k = (key ?? '').trim().toLowerCase();
  if (k.endsWith('.gif')) return 'gif';
  if (k.endsWith('.jpg') || k.endsWith('.jpeg') || k.endsWith('.png') || k.endsWith('.webp')) return 'image';
  if (k.endsWith('.mp4') || k.endsWith('.webm') || k.endsWith('.mov') || k.endsWith('.m4v')) return 'video';
  return null;
}

/** Walks the upload prefixes in R2 and indexes unseen objects into MediaAsset. */
@Injectable()
export class AdminImageReviewSyncService {
  constructor(
    private readonly cfg: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly storage: AdminImageReviewStorageService,
  ) {}

  async syncSome(opts?: { maxPrefixes?: number; maxPagesPerPrefix?: number }) {
    const { s3, bucket } = this.storage.requireR2();
    const prefix = this.storage.objectKeyPrefix();

    // ── SYNC PREFIX REGISTRY ────────────────────────────────────────────────
    // All R2 subdirectories that can receive uploads. Add here when a new
    // upload surface is wired so the admin index stays complete.
    //
    //   uploads/       — post media, group images, crew images (purpose-routed)
    //   avatars/       — user profile avatars
    //   covers/        — legacy (user covers / banners)
    //   banners/       — legacy
    //   article-thumbnails/ — article cover thumbnails
    //   article-media/      — inline images embedded in article body
    //   announcement-images/ — admin announcement / ad heroes
    // ────────────────────────────────────────────────────────────────────────
    const prefixes = [
      `${prefix}uploads/`,
      `${prefix}avatars/`,
      `${prefix}covers/`,
      `${prefix}banners/`,
      `${prefix}article-thumbnails/`,
      `${prefix}article-media/`,
      `${prefix}announcement-images/`,
      ...(this.cfg.channelMediaBucket() ? [`${prefix}channel-uploads/`] : []),
    ].slice(0, opts?.maxPrefixes ?? 20);

    for (const pfx of prefixes) {
      let continuationToken: string | undefined = undefined;
      let pages = 0;
      while (pages < (opts?.maxPagesPerPrefix ?? 2)) {
        pages += 1;
        const res: ListObjectsV2CommandOutput = await s3.send(
          new ListObjectsV2Command({
            Bucket: isProtectedChannelKey(pfx) ? this.storage.bucketForKey(pfx) : bucket,
            Prefix: pfx,
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
          }),
        );
        continuationToken = res.NextContinuationToken ?? undefined;

        const objs = res.Contents ?? [];
        if (objs.length === 0) break;

        const now = new Date();
        for (const o of objs) {
          const key = (o.Key ?? '').trim();
          if (!key) continue;
          const lastModified = o.LastModified ?? null;
          const bytes = typeof o.Size === 'number' && Number.isFinite(o.Size) ? Math.max(0, Math.floor(o.Size)) : null;
          const kind = guessKindFromKey(key);
          await this.prisma.mediaAsset.upsert({
            where: { r2Key: key },
            create: {
              r2Key: key,
              r2LastModified: lastModified ?? now,
              bytes: bytes ?? undefined,
              kind: kind ?? undefined,
            },
            update: {
              r2LastModified: lastModified ?? now,
              bytes: bytes ?? undefined,
              kind: kind ?? undefined,
            },
          });
        }

        if (!continuationToken) break;
      }
    }
  }
}
