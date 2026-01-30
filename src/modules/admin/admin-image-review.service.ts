import { DeleteObjectCommand, ListObjectsV2Command, type ListObjectsV2CommandOutput, S3Client } from '@aws-sdk/client-s3';
import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type PostMediaKind } from '@prisma/client';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { publicAssetUrl } from '../../common/assets/public-asset-url';

function parseBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(s);
}

function guessKindFromKey(key: string): PostMediaKind | null {
  const k = (key ?? '').trim().toLowerCase();
  if (k.endsWith('.gif')) return 'gif';
  if (k.endsWith('.jpg') || k.endsWith('.jpeg') || k.endsWith('.png') || k.endsWith('.webp')) return 'image';
  return null;
}

type CursorToken = { lm: string; id: string };

function encodeCursor(c: CursorToken): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(token: string | null): CursorToken | null {
  const t = (token ?? '').trim();
  if (!t) return null;
  try {
    const raw = Buffer.from(t, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as Partial<CursorToken>;
    const lm = typeof parsed.lm === 'string' ? parsed.lm : '';
    const id = typeof parsed.id === 'string' ? parsed.id : '';
    if (!lm || !id) return null;
    return { lm, id };
  } catch {
    return null;
  }
}

@Injectable()
export class AdminImageReviewService {
  private readonly s3: S3Client | null;
  private readonly bucket: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfigService,
  ) {
    const r2 = this.cfg.r2();
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

  private requireR2(): { s3: S3Client; bucket: string } {
    if (!this.s3 || !this.bucket) throw new ServiceUnavailableException('R2 is not configured.');
    return { s3: this.s3, bucket: this.bucket };
  }

  private objectKeyPrefix() {
    return this.cfg.isProd() ? '' : 'dev/';
  }

  private publicUrlForKey(key: string | null): string | null {
    return publicAssetUrl({ publicBaseUrl: this.cfg.r2()?.publicBaseUrl ?? null, key });
  }

  private async syncSome(opts?: { maxPrefixes?: number; maxPagesPerPrefix?: number }) {
    const { s3, bucket } = this.requireR2();
    const prefix = this.objectKeyPrefix();

    // Index known buckets of images.
    const prefixes = [
      `${prefix}uploads/`,
      `${prefix}avatars/`,
      `${prefix}covers/`,
      `${prefix}banners/`, // legacy
    ].slice(0, opts?.maxPrefixes ?? 20);

    for (const pfx of prefixes) {
      let continuationToken: string | undefined = undefined;
      let pages = 0;
      while (pages < (opts?.maxPagesPerPrefix ?? 2)) {
        pages += 1;
        const res: ListObjectsV2CommandOutput = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: pfx,
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
          }),
        );
        continuationToken = res.NextContinuationToken ?? undefined;

        const objs = res.Contents ?? [];
        if (objs.length === 0) break;

        // Upsert in small batches.
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

  async list(params: {
    limit: number;
    cursor: string | null;
    q?: string | null;
    showDeleted?: boolean;
    onlyOrphans?: boolean;
    sync?: boolean;
  }) {
    const take = Math.max(1, Math.min(100, Math.floor(params.limit || 30)));
    const showDeleted = Boolean(params.showDeleted);
    const onlyOrphans = Boolean(params.onlyOrphans);
    const q = (params.q ?? '').trim();
    const sync = Boolean(params.sync);

    if (sync) {
      // Admin-triggered incremental sync. Keep bounded so we don't time out.
      await this.syncSome({ maxPagesPerPrefix: 2 });
    }

    const decoded = decodeCursor(params.cursor);
    const cursorLm = decoded ? new Date(decoded.lm) : null;
    const cursorId = decoded ? decoded.id : null;

    const where: Prisma.MediaAssetWhereInput = {
      ...(showDeleted ? {} : { deletedAt: null }),
      ...(q ? { r2Key: { contains: q, mode: 'insensitive' } } : {}),
    };

    // Scan pagination (supports onlyOrphans without complex SQL by scanning and filtering).
    const out: any[] = [];
    let scannedThrough: { r2LastModified: Date; id: string } | null = null;
    let scanCursor = decoded ? { lm: cursorLm as Date, id: cursorId as string } : null;

    for (let pass = 0; pass < 4 && out.length < take; pass++) {
      const page = await this.prisma.mediaAsset.findMany({
        where: {
          AND: [
            where,
            ...(scanCursor
              ? [
                  {
                    OR: [
                      { r2LastModified: { lt: scanCursor.lm } },
                      { r2LastModified: scanCursor.lm, id: { lt: scanCursor.id } },
                    ],
                  } as Prisma.MediaAssetWhereInput,
                ]
              : []),
          ],
        },
        orderBy: [{ r2LastModified: 'desc' }, { id: 'desc' }],
        take: take + 50,
      });

      if (!page.length) break;

      const keys = page.map((x) => x.r2Key);
      const postMedia = await this.prisma.postMedia.findMany({
        where: { r2Key: { in: keys } },
        select: { r2Key: true, postId: true },
      });
      const postKeySet = new Set(postMedia.map((m) => m.r2Key ?? '').filter(Boolean));

      const userRefs = await this.prisma.user.findMany({
        where: { OR: [{ avatarKey: { in: keys } }, { bannerKey: { in: keys } }] },
        select: { avatarKey: true, bannerKey: true },
      });
      const userKeySet = new Set<string>();
      for (const u of userRefs) {
        if (u.avatarKey) userKeySet.add(u.avatarKey);
        if (u.bannerKey) userKeySet.add(u.bannerKey);
      }

      for (const a of page) {
        scannedThrough = { r2LastModified: a.r2LastModified ?? a.createdAt, id: a.id };
        const inPost = postKeySet.has(a.r2Key);
        const inUser = userKeySet.has(a.r2Key);
        const belongsToSummary = inPost ? 'post' : inUser ? 'user' : 'orphan';
        if (onlyOrphans && belongsToSummary !== 'orphan') continue;

        out.push({
          id: a.id,
          r2Key: a.r2Key,
          lastModified: (a.r2LastModified ?? a.createdAt).toISOString(),
          publicUrl: this.publicUrlForKey(a.deletedAt ? null : a.r2Key),
          deletedAt: a.deletedAt ? a.deletedAt.toISOString() : null,
          belongsToSummary,
        });
        if (out.length >= take) break;
      }

      const last = page[page.length - 1];
      if (!last) break;
      scanCursor = { lm: last.r2LastModified ?? last.createdAt, id: last.id };
      if (page.length < take + 50) break;
    }

    const nextCursor =
      out.length >= take && scannedThrough
        ? encodeCursor({ lm: scannedThrough.r2LastModified.toISOString(), id: scannedThrough.id })
        : null;

    return { items: out, nextCursor };
  }

  async getById(id: string) {
    const assetId = (id ?? '').trim();
    if (!assetId) throw new NotFoundException('Not found.');
    const a = await this.prisma.mediaAsset.findUnique({ where: { id: assetId } });
    if (!a) throw new NotFoundException('Not found.');

    const postMedia = await this.prisma.postMedia.findMany({
      where: { r2Key: a.r2Key },
      include: { post: { include: { user: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const users = await this.prisma.user.findMany({
      where: { OR: [{ avatarKey: a.r2Key }, { bannerKey: a.r2Key }] },
      select: { id: true, username: true, name: true, premium: true, verifiedStatus: true },
    });

    const publicUrl = this.publicUrlForKey(a.deletedAt ? null : a.r2Key);

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
      },
      references: {
        posts: postMedia.map((m) => ({
          postMediaId: m.id,
          postId: m.postId,
          postCreatedAt: m.post.createdAt.toISOString(),
          postVisibility: m.post.visibility,
          author: {
            id: m.post.user.id,
            username: m.post.user.username,
          },
          deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
        })),
        users,
      },
    };
  }

  async deleteById(params: { id: string; adminUserId: string; reason?: string | null }) {
    const assetId = (params.id ?? '').trim();
    if (!assetId) throw new NotFoundException('Not found.');
    const reason = (params.reason ?? '').trim() || null;
    if (!reason) throw new BadRequestException('Reason is required.');

    const a = await this.prisma.mediaAsset.findUnique({ where: { id: assetId } });
    if (!a) throw new NotFoundException('Not found.');
    if (a.deletedAt) {
      return { success: true, alreadyDeleted: true };
    }

    const now = new Date();
    const r2Key = a.r2Key;

    const affected = await this.prisma.$transaction(async (tx) => {
      await tx.mediaAsset.update({
        where: { id: a.id },
        data: {
          deletedAt: now,
          deletedByAdminId: params.adminUserId,
          deleteReason: reason,
        },
      });

      const postMedia = await tx.postMedia.findMany({
        where: { r2Key, source: 'upload' },
        select: { id: true, postId: true },
      });

      if (postMedia.length) {
        await tx.postMedia.updateMany({
          where: { r2Key, source: 'upload' },
          data: {
            deletedAt: now,
            deletedByAdminId: params.adminUserId,
            deletedReason: reason,
          },
        });
      }

      const users = await tx.user.findMany({
        where: { OR: [{ avatarKey: r2Key }, { bannerKey: r2Key }] },
        select: { id: true, avatarKey: true, bannerKey: true },
      });

      for (const u of users) {
        const data: Prisma.UserUpdateInput = {};
        if (u.avatarKey === r2Key) {
          data.avatarKey = null;
          data.avatarUpdatedAt = now;
        }
        if (u.bannerKey === r2Key) {
          data.bannerKey = null;
          data.bannerUpdatedAt = now;
        }
        if (Object.keys(data).length) {
          await tx.user.update({ where: { id: u.id }, data });
        }
      }

      return {
        postMediaCount: postMedia.length,
        userCount: users.length,
      };
    });

    // Hard delete from R2.
    const { s3, bucket } = this.requireR2();
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: r2Key }));
      await this.prisma.mediaAsset.update({ where: { id: a.id }, data: { r2DeletedAt: new Date() } });
      return { success: true, alreadyDeleted: false, r2Deleted: true, ...affected };
    } catch (e: unknown) {
      // Tombstone exists; report failure so admin can retry.
      return { success: true, alreadyDeleted: false, r2Deleted: false, error: String((e as any)?.message ?? e), ...affected };
    }
  }

  // Small helper for controllers to parse booleans without duplicating logic.
  parseBool(v: unknown) {
    return parseBool(v);
  }
}

