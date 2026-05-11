import { DeleteObjectCommand, ListObjectsV2Command, type ListObjectsV2CommandOutput, S3Client } from '@aws-sdk/client-s3';
import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type PostMediaKind } from '@prisma/client';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';

// ============================================================
// REFERENCE TYPES — shapes returned by resolveAllReferences()
// ============================================================

type PostRef = {
  postMediaId: string;
  postId: string;
  postCreatedAt: string;
  postVisibility: string;
  authorId: string;
  authorUsername: string | null;
  deletedAt: string | null;
  /** true when this key is a video poster frame (thumbnailR2Key), not the main asset */
  isThumbnail: boolean;
};

type MessageRef = {
  messageMediaId: string;
  messageId: string;
  conversationId: string;
  isThumbnail: boolean;
};

type UserRef = {
  userId: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: string | null;
  isAvatar: boolean;
  isBanner: boolean;
};

type GroupRef = {
  groupId: string;
  slug: string;
  name: string;
  isAvatar: boolean;
  isCover: boolean;
};

type CrewRef = {
  crewId: string;
  slug: string;
  name: string | null;
  isAvatar: boolean;
  isCover: boolean;
};

type PollRef = {
  pollOptionId: string;
  pollId: string;
  postId: string;
};

type ArticleRef = {
  articleId: string;
  title: string | null;
  authorId: string;
};

export type AssetPrimaryType =
  | 'post'
  | 'post_thumbnail'
  | 'message'
  | 'message_thumbnail'
  | 'user'
  | 'group'
  | 'crew'
  | 'poll'
  | 'article'
  | 'orphan';

type AssetRefs = {
  posts: PostRef[];
  messages: MessageRef[];
  users: UserRef[];
  groups: GroupRef[];
  crews: CrewRef[];
  polls: PollRef[];
  articles: ArticleRef[];
  primaryType: AssetPrimaryType;
};

// ============================================================

function parseBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(s);
}

function guessKindFromKey(key: string): PostMediaKind | null {
  const k = (key ?? '').trim().toLowerCase();
  if (k.endsWith('.gif')) return 'gif';
  if (k.endsWith('.jpg') || k.endsWith('.jpeg') || k.endsWith('.png') || k.endsWith('.webp')) return 'image';
  if (k.endsWith('.mp4') || k.endsWith('.webm') || k.endsWith('.mov') || k.endsWith('.m4v')) return 'video';
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
  private readonly logger = new Logger(AdminImageReviewService.name);
  private readonly s3: S3Client | null;
  private readonly bucket: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfigService,
    private readonly publicProfileCache: PublicProfileCacheService<{ id: string; username: string | null }>,
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
    // ────────────────────────────────────────────────────────────────────────
    const prefixes = [
      `${prefix}uploads/`,
      `${prefix}avatars/`,
      `${prefix}covers/`,
      `${prefix}banners/`,
      `${prefix}article-thumbnails/`,
      `${prefix}article-media/`,
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

  /**
   * ============================================================
   * REFERENCE REGISTRY — the single source of truth for every
   * DB table that stores an R2 object key.
   *
   * When you add a new upload surface you MUST add it here, or:
   *   • orphan detection will false-positive on those assets
   *   • admin deletes will leave dangling references in the DB
   *
   * Current holders:
   *   PostMedia.r2Key              (post images / GIFs / videos)
   *   PostMedia.thumbnailR2Key     (video poster frames for posts)
   *   MessageMedia.r2Key           (DM / crew-wall images)
   *   MessageMedia.thumbnailR2Key  (DM / crew-wall video thumbnails)
   *   User.avatarKey               (profile avatar)
   *   User.bannerKey               (profile banner)
   *   CommunityGroup.avatarImageUrl  (full URL — group square avatar)
   *   CommunityGroup.coverImageUrl   (full URL — group wide banner)
   *   Crew.avatarImageUrl            (full URL — crew square avatar)
   *   Crew.coverImageUrl             (full URL — crew wide banner)
   *   PostPollOption.imageR2Key    (poll option images)
   *   Article.thumbnailR2Key       (article cover thumbnails)
   * ============================================================
   */
  private async resolveAllReferences(keys: string[]): Promise<Map<string, AssetRefs>> {
    const result = new Map<string, AssetRefs>();
    const keySet = new Set(keys.filter(Boolean));

    for (const key of keySet) {
      result.set(key, { posts: [], messages: [], users: [], groups: [], crews: [], polls: [], articles: [], primaryType: 'orphan' });
    }

    if (!keySet.size) return result;

    const keyArr = [...keySet];

    // ── 1. PostMedia (r2Key + thumbnailR2Key) ──────────────────────────────
    const postMediaRows = await this.prisma.postMedia.findMany({
      where: { OR: [{ r2Key: { in: keyArr } }, { thumbnailR2Key: { in: keyArr } }] },
      select: {
        id: true,
        postId: true,
        r2Key: true,
        thumbnailR2Key: true,
        deletedAt: true,
        post: {
          select: {
            id: true,
            createdAt: true,
            visibility: true,
            user: { select: { id: true, username: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }],
    });
    for (const m of postMediaRows) {
      const base: PostRef = {
        postMediaId: m.id,
        postId: m.postId,
        postCreatedAt: m.post.createdAt.toISOString(),
        postVisibility: m.post.visibility,
        authorId: m.post.user.id,
        authorUsername: m.post.user.username ?? null,
        deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
        isThumbnail: false,
      };
      if (m.r2Key && keySet.has(m.r2Key)) {
        result.get(m.r2Key)!.posts.push(base);
      }
      if (m.thumbnailR2Key && keySet.has(m.thumbnailR2Key)) {
        result.get(m.thumbnailR2Key)!.posts.push({ ...base, isThumbnail: true });
      }
    }

    // ── 2. MessageMedia (r2Key + thumbnailR2Key) ───────────────────────────
    const msgMediaRows = await this.prisma.messageMedia.findMany({
      where: { OR: [{ r2Key: { in: keyArr } }, { thumbnailR2Key: { in: keyArr } }] },
      select: {
        id: true,
        messageId: true,
        r2Key: true,
        thumbnailR2Key: true,
        message: { select: { conversationId: true } },
      },
    });
    for (const m of msgMediaRows) {
      const base: MessageRef = {
        messageMediaId: m.id,
        messageId: m.messageId,
        conversationId: m.message.conversationId,
        isThumbnail: false,
      };
      if (m.r2Key && keySet.has(m.r2Key)) {
        result.get(m.r2Key)!.messages.push(base);
      }
      if (m.thumbnailR2Key && keySet.has(m.thumbnailR2Key)) {
        result.get(m.thumbnailR2Key)!.messages.push({ ...base, isThumbnail: true });
      }
    }

    // ── 3. User (avatarKey + bannerKey) ────────────────────────────────────
    const userRows = await this.prisma.user.findMany({
      where: { OR: [{ avatarKey: { in: keyArr } }, { bannerKey: { in: keyArr } }] },
      select: {
        id: true,
        username: true,
        name: true,
        premium: true,
        premiumPlus: true,
        stewardBadgeEnabled: true,
        verifiedStatus: true,
        avatarKey: true,
        bannerKey: true,
      },
    });
    for (const u of userRows) {
      const base: UserRef = {
        userId: u.id,
        username: u.username ?? null,
        name: u.name ?? null,
        premium: u.premium,
        premiumPlus: u.premiumPlus,
        stewardBadgeEnabled: u.stewardBadgeEnabled,
        verifiedStatus: u.verifiedStatus ?? null,
        isAvatar: false,
        isBanner: false,
      };
      if (u.avatarKey && keySet.has(u.avatarKey)) {
        result.get(u.avatarKey)!.users.push({ ...base, isAvatar: true });
      }
      if (u.bannerKey && keySet.has(u.bannerKey)) {
        result.get(u.bannerKey)!.users.push({ ...base, isBanner: true });
      }
    }

    // ── 4. CommunityGroup + Crew (stored as full URLs) ─────────────────────
    // Build a URL → key reverse-lookup so we can match full-URL fields back
    // to the raw R2 key we're resolving.
    const urlToKey = new Map<string, string>();
    const publicBase = this.cfg.r2()?.publicBaseUrl ?? null;
    if (publicBase) {
      for (const key of keySet) {
        const url = this.publicUrlForKey(key);
        if (url) urlToKey.set(url, key);
      }
    } else {
      this.logger.warn(
        '[media-review] R2 publicBaseUrl not configured — group/crew references cannot be resolved by URL',
      );
    }

    if (urlToKey.size > 0) {
      const urlArr = [...urlToKey.keys()];

      const groupRows = await this.prisma.communityGroup.findMany({
        where: { OR: [{ avatarImageUrl: { in: urlArr } }, { coverImageUrl: { in: urlArr } }] },
        select: { id: true, slug: true, name: true, avatarImageUrl: true, coverImageUrl: true },
      });
      for (const g of groupRows) {
        if (g.avatarImageUrl && urlToKey.has(g.avatarImageUrl)) {
          const key = urlToKey.get(g.avatarImageUrl)!;
          result.get(key)!.groups.push({ groupId: g.id, slug: g.slug, name: g.name, isAvatar: true, isCover: false });
        }
        if (g.coverImageUrl && urlToKey.has(g.coverImageUrl)) {
          const key = urlToKey.get(g.coverImageUrl)!;
          result.get(key)!.groups.push({ groupId: g.id, slug: g.slug, name: g.name, isAvatar: false, isCover: true });
        }
      }

      const crewRows = await this.prisma.crew.findMany({
        where: { OR: [{ avatarImageUrl: { in: urlArr } }, { coverImageUrl: { in: urlArr } }] },
        select: { id: true, slug: true, name: true, avatarImageUrl: true, coverImageUrl: true },
      });
      for (const c of crewRows) {
        if (c.avatarImageUrl && urlToKey.has(c.avatarImageUrl)) {
          const key = urlToKey.get(c.avatarImageUrl)!;
          result.get(key)!.crews.push({ crewId: c.id, slug: c.slug, name: c.name ?? null, isAvatar: true, isCover: false });
        }
        if (c.coverImageUrl && urlToKey.has(c.coverImageUrl)) {
          const key = urlToKey.get(c.coverImageUrl)!;
          result.get(key)!.crews.push({ crewId: c.id, slug: c.slug, name: c.name ?? null, isAvatar: false, isCover: true });
        }
      }
    }

    // ── 5. PostPollOption (imageR2Key) ─────────────────────────────────────
    const pollOptionRows = await this.prisma.postPollOption.findMany({
      where: { imageR2Key: { in: keyArr } },
      select: {
        id: true,
        pollId: true,
        imageR2Key: true,
        poll: { select: { postId: true } },
      },
    });
    for (const o of pollOptionRows) {
      if (!o.imageR2Key || !keySet.has(o.imageR2Key)) continue;
      result.get(o.imageR2Key)!.polls.push({
        pollOptionId: o.id,
        pollId: o.pollId,
        postId: o.poll.postId,
      });
    }

    // ── 6. Article (thumbnailR2Key) ────────────────────────────────────────
    const articleRows = await this.prisma.article.findMany({
      where: { thumbnailR2Key: { in: keyArr } },
      select: { id: true, title: true, thumbnailR2Key: true, authorId: true },
    });
    for (const a of articleRows) {
      if (!a.thumbnailR2Key || !keySet.has(a.thumbnailR2Key)) continue;
      result.get(a.thumbnailR2Key)!.articles.push({
        articleId: a.id,
        title: a.title ?? null,
        authorId: a.authorId,
      });
    }

    // ── Determine primaryType for each key ─────────────────────────────────
    for (const refs of result.values()) {
      if (refs.posts.some((p) => !p.isThumbnail)) refs.primaryType = 'post';
      else if (refs.messages.some((m) => !m.isThumbnail)) refs.primaryType = 'message';
      else if (refs.users.length > 0) refs.primaryType = 'user';
      else if (refs.groups.length > 0) refs.primaryType = 'group';
      else if (refs.crews.length > 0) refs.primaryType = 'crew';
      else if (refs.polls.length > 0) refs.primaryType = 'poll';
      else if (refs.articles.length > 0) refs.primaryType = 'article';
      else if (refs.posts.some((p) => p.isThumbnail)) refs.primaryType = 'post_thumbnail';
      else if (refs.messages.some((m) => m.isThumbnail)) refs.primaryType = 'message_thumbnail';
      else refs.primaryType = 'orphan';
    }

    return result;
  }

  async list(params: {
    limit: number;
    cursor: string | null;
    q?: string | null;
    showDeleted?: boolean;
    onlyOrphans?: boolean;
    sync?: boolean;
    kind?: 'all' | 'image' | 'video' | null;
  }) {
    const take = Math.max(1, Math.min(100, Math.floor(params.limit || 30)));
    const showDeleted = Boolean(params.showDeleted);
    const onlyOrphans = Boolean(params.onlyOrphans);
    const q = (params.q ?? '').trim();
    const sync = Boolean(params.sync);
    const kindFilter = params.kind ?? 'all';

    if (sync) {
      await this.syncSome({ maxPagesPerPrefix: 2 });
    }

    const decoded = decodeCursor(params.cursor);
    const cursorLm = decoded ? new Date(decoded.lm) : null;
    const cursorId = decoded ? decoded.id : null;

    const kindWhere: Prisma.MediaAssetWhereInput =
      kindFilter === 'image' ? { kind: { in: ['image', 'gif'] } } : kindFilter === 'video' ? { kind: 'video' } : {};

    const where: Prisma.MediaAssetWhereInput = {
      ...(showDeleted ? {} : { deletedAt: null }),
      ...(q ? { r2Key: { contains: q, mode: 'insensitive' } } : {}),
      ...kindWhere,
    };

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
      const refsMap = await this.resolveAllReferences(keys);

      for (const a of page) {
        scannedThrough = { r2LastModified: a.r2LastModified ?? a.createdAt, id: a.id };
        const refs = refsMap.get(a.r2Key) ?? {
          posts: [], messages: [], users: [], groups: [], crews: [], polls: [], articles: [], primaryType: 'orphan' as AssetPrimaryType,
        };
        const { primaryType } = refs;
        if (onlyOrphans && primaryType !== 'orphan') continue;

        const postRef = refs.posts[0];
        const userRef = refs.users[0];
        const groupRef = refs.groups[0];
        const crewRef = refs.crews[0];
        const pollRef = refs.polls[0];
        const articleRef = refs.articles[0];
        const msgRef = refs.messages[0];

        out.push({
          id: a.id,
          r2Key: a.r2Key,
          kind: a.kind ?? null,
          lastModified: (a.r2LastModified ?? a.createdAt).toISOString(),
          publicUrl: this.publicUrlForKey(a.deletedAt ? null : a.r2Key),
          deletedAt: a.deletedAt ? a.deletedAt.toISOString() : null,
          belongsToSummary: primaryType,
          // Post (backward compat fields preserved)
          postId: postRef?.postId ?? null,
          authorUsername: postRef?.authorUsername ?? null,
          // User (backward compat fields preserved)
          userId: userRef?.userId ?? null,
          profileUsername: userRef?.username ?? null,
          // New fields
          groupId: groupRef?.groupId ?? null,
          groupName: groupRef?.name ?? null,
          crewId: crewRef?.crewId ?? null,
          crewName: crewRef?.name ?? null,
          pollPostId: pollRef?.postId ?? null,
          articleId: articleRef?.articleId ?? null,
          messageId: msgRef?.messageId ?? null,
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

    const refsMap = await this.resolveAllReferences([a.r2Key]);
    const refs = refsMap.get(a.r2Key) ?? {
      posts: [], messages: [], users: [], groups: [], crews: [], polls: [], articles: [], primaryType: 'orphan' as AssetPrimaryType,
    };

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
        primaryType: refs.primaryType,
      },
      references: {
        posts: refs.posts.map((p) => ({
          postMediaId: p.postMediaId,
          postId: p.postId,
          postCreatedAt: p.postCreatedAt,
          postVisibility: p.postVisibility,
          author: { id: p.authorId, username: p.authorUsername },
          deletedAt: p.deletedAt,
          isThumbnail: p.isThumbnail,
        })),
        messages: refs.messages,
        users: refs.users.map((u) => ({
          id: u.userId,
          username: u.username,
          name: u.name,
          premium: u.premium,
          premiumPlus: u.premiumPlus,
          stewardBadgeEnabled: u.stewardBadgeEnabled,
          verifiedStatus: u.verifiedStatus,
          isAvatar: u.isAvatar,
          isBanner: u.isBanner,
        })),
        groups: refs.groups,
        crews: refs.crews,
        polls: refs.polls,
        articles: refs.articles,
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
    const fullUrl = this.publicUrlForKey(r2Key);

    const affected = await this.prisma.$transaction(async (tx) => {
      // ── Tombstone the asset index row ──────────────────────────────────────
      await tx.mediaAsset.update({
        where: { id: a.id },
        data: {
          deletedAt: now,
          deletedByAdminId: params.adminUserId,
          deleteReason: reason,
        },
      });

      // Prevent future "same file" uploads from reusing this tombstoned key.
      await tx.mediaContentHash.deleteMany({ where: { r2Key } });

      // ── PostMedia: tombstone rows where this is the main asset ─────────────
      const postMediaDirect = await tx.postMedia.findMany({
        where: { r2Key, source: 'upload' },
        select: { id: true, postId: true },
      });
      if (postMediaDirect.length) {
        await tx.postMedia.updateMany({
          where: { r2Key, source: 'upload' },
          data: { deletedAt: now, deletedByAdminId: params.adminUserId, deletedReason: reason },
        });
      }

      // ── PostMedia: null out thumbnail where this is a poster frame ─────────
      const { count: postMediaThumbnailCount } = await tx.postMedia.updateMany({
        where: { thumbnailR2Key: r2Key },
        data: { thumbnailR2Key: null },
      });

      // ── MessageMedia: hard-delete rows where this is the main upload ───────
      // (MessageMedia has no tombstone field; the message body still exists)
      const { count: messageMediaCount } = await tx.messageMedia.deleteMany({ where: { r2Key, source: 'upload' } });

      // ── MessageMedia: null out thumbnail ───────────────────────────────────
      const { count: messageMediaThumbnailCount } = await tx.messageMedia.updateMany({
        where: { thumbnailR2Key: r2Key },
        data: { thumbnailR2Key: null },
      });

      // ── User avatar / banner ───────────────────────────────────────────────
      const users = await tx.user.findMany({
        where: { OR: [{ avatarKey: r2Key }, { bannerKey: r2Key }] },
        select: { id: true, username: true, avatarKey: true, bannerKey: true },
      });
      const invalidatedUsers: Array<{ id: string; username: string | null }> = [];
      for (const u of users) {
        const data: Prisma.UserUpdateInput = {};
        if (u.avatarKey === r2Key) { data.avatarKey = null; data.avatarUpdatedAt = now; }
        if (u.bannerKey === r2Key) { data.bannerKey = null; data.bannerUpdatedAt = now; }
        if (Object.keys(data).length) {
          await tx.user.update({ where: { id: u.id }, data });
          invalidatedUsers.push({ id: u.id, username: u.username ?? null });
        }
      }

      // ── CommunityGroup avatar / cover (stored as full URL) ─────────────────
      let groupCount = 0;
      let crewCount = 0;
      if (fullUrl) {
        const { count: ga } = await tx.communityGroup.updateMany({ where: { avatarImageUrl: fullUrl }, data: { avatarImageUrl: null } });
        const { count: gc } = await tx.communityGroup.updateMany({ where: { coverImageUrl: fullUrl }, data: { coverImageUrl: null } });
        groupCount = ga + gc;

        // ── Crew avatar / cover (stored as full URL) ─────────────────────────
        const { count: ca } = await tx.crew.updateMany({ where: { avatarImageUrl: fullUrl }, data: { avatarImageUrl: null } });
        const { count: cc } = await tx.crew.updateMany({ where: { coverImageUrl: fullUrl }, data: { coverImageUrl: null } });
        crewCount = ca + cc;
      }

      // ── PostPollOption image ───────────────────────────────────────────────
      const { count: pollOptionCount } = await tx.postPollOption.updateMany({
        where: { imageR2Key: r2Key },
        data: { imageR2Key: null },
      });

      // ── Article thumbnail ──────────────────────────────────────────────────
      const { count: articleCount } = await tx.article.updateMany({
        where: { thumbnailR2Key: r2Key },
        data: { thumbnailR2Key: null },
      });

      return {
        postMediaCount: postMediaDirect.length,
        postMediaThumbnailCount,
        messageMediaCount,
        messageMediaThumbnailCount,
        userCount: users.length,
        groupCount,
        crewCount,
        pollOptionCount,
        articleCount,
        invalidatedUsers,
      };
    });

    const { invalidatedUsers, ...affectedCounts } = affected;
    for (const u of invalidatedUsers) {
      await this.publicProfileCache.invalidateForUser(u);
    }

    // ── Hard-delete from R2 ────────────────────────────────────────────────
    const { s3, bucket } = this.requireR2();
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: r2Key }));
      await this.prisma.mediaAsset.update({ where: { id: a.id }, data: { r2DeletedAt: new Date() } });
      return { success: true, alreadyDeleted: false, r2Deleted: true, ...affectedCounts };
    } catch (e: unknown) {
      return { success: true, alreadyDeleted: false, r2Deleted: false, error: String((e as any)?.message ?? e), ...affectedCounts };
    }
  }

  /**
   * Bulk-delete up to 200 assets in one admin action. Skips already-deleted
   * assets silently; collects errors per-id so one bad id doesn't abort the batch.
   */
  async deleteManyByIds(params: {
    ids: string[];
    adminUserId: string;
    reason: string;
  }): Promise<{ deleted: number; skipped: number; errors: Array<{ id: string; message: string }> }> {
    const ids = [...new Set(params.ids.map((id) => id.trim()).filter(Boolean))].slice(0, 200);
    let deleted = 0;
    let skipped = 0;
    const errors: Array<{ id: string; message: string }> = [];

    for (const id of ids) {
      try {
        const result = await this.deleteById({ id, adminUserId: params.adminUserId, reason: params.reason });
        if (result.alreadyDeleted) skipped += 1;
        else deleted += 1;
      } catch (err) {
        errors.push({ id, message: err instanceof Error ? err.message : String(err) });
      }
    }

    this.logger.log(
      `[media-review] bulk-delete admin=${params.adminUserId} requested=${ids.length} deleted=${deleted} skipped=${skipped} errors=${errors.length}`,
    );
    return { deleted, skipped, errors };
  }

  parseBool(v: unknown) {
    return parseBool(v);
  }
}
