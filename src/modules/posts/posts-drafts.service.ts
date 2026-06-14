import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { parseMentionsFromBody as parseMentionsFromBodyText } from '../../common/mentions/mention-regex';
import { parseHashtagTokensFromText } from '../../common/hashtags/hashtag-regex';
import { inferTopicsFromText } from '../../common/topics/topic-utils';
import { MENTION_USER_SELECT, USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { notDeletedWhere } from './posts-query-builders';
import { resolveMentionUsernames } from './posts-mentions.helpers';

type DraftMediaInput = {
  source: 'upload' | 'giphy';
  kind: 'image' | 'gif' | 'video';
  r2Key?: string;
  thumbnailR2Key?: string;
  url?: string;
  mp4Url?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  alt?: string | null;
};

type CleanedDraftMedia = {
  source: 'upload' | 'giphy';
  kind: 'image' | 'gif' | 'video';
  r2Key: string | null;
  thumbnailR2Key?: string;
  url: string | null;
  mp4Url: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  alt: string | null;
  position: number;
};

/**
 * Draft posts: onlyMe + isDraft rows the composer saves before publishing.
 * Publishing a draft goes through PostsService.publishFromOnlyMe → createPost
 * (which owns the side-effect pipeline); this service only manages the draft
 * rows themselves.
 */
@Injectable()
export class PostsDraftsService {
  constructor(private readonly prisma: PrismaService) {}

  async listDrafts(params: { userId: string; limit: number; cursor: string | null }) {
    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const cursor = (params.cursor ?? '').trim() || null;

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const rows = await this.prisma.post.findMany({
      where: {
        AND: [
          notDeletedWhere(),
          { userId: params.userId },
          { visibility: 'onlyMe' },
          { isDraft: true },
          { parentId: null },
          { scheduledAt: null },
          ...(cursorWhere ? [cursorWhere as Prisma.PostWhereInput] : []),
        ],
      },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: {
          include: {
            user: {
              select: MENTION_USER_SELECT,
            },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? (slice[slice.length - 1]?.id ?? null) : null;
    return { posts: slice, nextCursor };
  }

  async createDraft(params: { userId: string; body: string; media: DraftMediaInput[] | null }) {
    const { userId } = params;
    const body = (params.body ?? '').trim();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { verifiedStatus: true, premium: true, premiumPlus: true },
    });
    if (!user) throw new NotFoundException('User not found.');

    const media = (params.media ?? []).filter(Boolean);
    if (media.length > 4) throw new BadRequestException('You can attach up to 4 images, GIFs, or videos.');

    const userIsVerified = Boolean(user.verifiedStatus && user.verifiedStatus !== 'none');
    const userIsPremium = Boolean(user.premium || user.premiumPlus);

    // Images/GIFs require verified; video requires premium.
    const hasDraftVideo = media.some((m) => m.kind === 'video');
    const hasDraftImageOrGif = media.some((m) => m.kind !== 'video');
    if (hasDraftImageOrGif && !userIsVerified) {
      throw new ForbiddenException('Verify your account to post images and GIFs.');
    }
    if (hasDraftVideo && !userIsPremium) {
      throw new ForbiddenException('Video posts are for premium members only.');
    }

    const maxLen = userIsPremium ? 1000 : 500;
    if (body.length > maxLen) {
      throw new BadRequestException(
        userIsPremium ? 'Posts are limited to 1000 characters.' : 'Posts are limited to 500 characters.',
      );
    }

    // Clean + validate media (same rules as createPost, but without notifications/mentions side-effects).
    const cleanedMedia = await this.cleanMediaItems(userId, media);

    const { topics, hashtags, hashtagCasings } = this.deriveBodyTags(body);

    const created = await this.prisma.post.create({
      data: {
        userId,
        body,
        visibility: 'onlyMe',
        isDraft: true,
        topics,
        hashtags,
        hashtagCasings,
        ...(cleanedMedia.length
          ? {
              media: {
                create: cleanedMedia,
              },
            }
          : {}),
      },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: {
          include: {
            user: {
              select: MENTION_USER_SELECT,
            },
          },
        },
      },
    });

    return created;
  }

  async updateDraft(params: { userId: string; draftId: string; body?: string; media: DraftMediaInput[] | null }) {
    const id = (params.draftId ?? '').trim();
    if (!id) throw new NotFoundException('Draft not found.');

    const post = await this.prisma.post.findUnique({
      where: { id },
      include: {
        user: { select: USER_LIST_SELECT },
        media: { orderBy: { position: 'asc' } },
        mentions: { select: { userId: true } },
      },
    });
    if (!post) throw new NotFoundException('Draft not found.');
    if (post.userId !== params.userId) throw new ForbiddenException('Not allowed.');
    if (post.deletedAt) throw new ForbiddenException('Draft not found.');
    if (post.visibility !== 'onlyMe' || !post.isDraft) throw new ForbiddenException('Not a draft.');
    if (post.parentId) throw new ForbiddenException('Not a draft.');

    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { premium: true, premiumPlus: true, verifiedStatus: true },
    });
    if (!user) throw new NotFoundException('User not found.');

    const updateUserIsVerified = Boolean(user.verifiedStatus && user.verifiedStatus !== 'none');
    const updateUserIsPremium = Boolean(user.premium || user.premiumPlus);

    const nextBody = typeof params.body === 'string' ? params.body.trim() : post.body;
    const maxLen = updateUserIsPremium ? 1000 : 500;
    if (nextBody.length > maxLen) {
      throw new BadRequestException(
        updateUserIsPremium ? 'Posts are limited to 1000 characters.' : 'Posts are limited to 500 characters.',
      );
    }

    const media = params.media === null ? null : (params.media ?? null);
    if (media && media.length > 4) throw new BadRequestException('You can attach up to 4 images, GIFs, or videos.');
    if ((media?.length ?? 0) > 0) {
      const hasUpdateVideo = media!.some((m) => m.kind === 'video');
      const hasUpdateImageOrGif = media!.some((m) => m.kind !== 'video');
      if (hasUpdateImageOrGif && !updateUserIsVerified) {
        throw new ForbiddenException('Verify your account to post images and GIFs.');
      }
      if (hasUpdateVideo && !updateUserIsPremium) {
        throw new ForbiddenException('Video posts are for premium members only.');
      }
    }

    // If media is provided, validate/clean; otherwise leave unchanged.
    const cleanedMedia = media ? await this.cleanMediaItems(params.userId, media) : null;

    const { topics, hashtags, hashtagCasings } = this.deriveBodyTags(nextBody);

    const fromBodyMentions = nextBody ? parseMentionsFromBodyText(nextBody) : [];
    const bodyMentionIds = await resolveMentionUsernames(this.prisma, fromBodyMentions);
    const existingMentionIds = (post.mentions ?? []).map((m) => m.userId);
    const mentionUserIds = Array.from(new Set([...existingMentionIds, ...bodyMentionIds])).filter(Boolean);

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.post.update({
        where: { id: post.id },
        data: {
          body: nextBody,
          topics,
          hashtags,
          hashtagCasings,
        },
        include: {
          user: { select: USER_LIST_SELECT },
          media: { orderBy: { position: 'asc' } },
          mentions: {
            include: {
              user: {
                select: MENTION_USER_SELECT,
              },
            },
          },
        },
      });

      if (cleanedMedia) {
        await tx.postMedia.deleteMany({ where: { postId: post.id } });
        if (cleanedMedia.length > 0) {
          await tx.postMedia.createMany({
            data: cleanedMedia.map((m) => ({
              postId: post.id,
              source: m.source,
              kind: m.kind,
              r2Key: m.r2Key ?? null,
              thumbnailR2Key: m.thumbnailR2Key ?? null,
              url: m.url ?? null,
              mp4Url: m.mp4Url ?? null,
              width: m.width ?? null,
              height: m.height ?? null,
              durationSeconds: m.durationSeconds ?? null,
              alt: m.alt ?? null,
              position: m.position,
            })),
            skipDuplicates: false,
          });
        }
      }

      await tx.postMention.deleteMany({ where: { postId: post.id } });
      if (mentionUserIds.length > 0) {
        await tx.postMention.createMany({
          data: mentionUserIds.map((uid) => ({ postId: post.id, userId: uid })),
          skipDuplicates: true,
        });
      }

      return next;
    });

    return updated;
  }

  async deleteDraft(params: { userId: string; draftId: string }) {
    const id = (params.draftId ?? '').trim();
    if (!id) throw new NotFoundException('Draft not found.');
    const post = await this.prisma.post.findUnique({ where: { id }, select: { id: true, userId: true, deletedAt: true, visibility: true, isDraft: true } });
    if (!post) throw new NotFoundException('Draft not found.');
    if (post.userId !== params.userId) throw new ForbiddenException('Not allowed.');
    if (post.visibility !== 'onlyMe' || !post.isDraft) throw new ForbiddenException('Not a draft.');
    if (post.deletedAt) return { success: true };
    await this.prisma.post.update({ where: { id }, data: { deletedAt: new Date() } });
    return { success: true };
  }

  /** Lowercased hashtags, display casings, and inferred topics from a draft body. */
  private deriveBodyTags(body: string): { topics: string[]; hashtags: string[]; hashtagCasings: string[] } {
    const hashtagTokensRaw = body ? parseHashtagTokensFromText(body) : [];
    const hashtagTokens = hashtagTokensRaw
      .map((t) => ({ tag: (t.tag ?? '').trim().toLowerCase(), variant: (t.variant ?? '').trim() }))
      .filter((t) => Boolean(t.tag && t.variant));
    hashtagTokens.sort((a, b) => a.tag.localeCompare(b.tag) || a.variant.localeCompare(b.variant));
    const hashtags = hashtagTokens.map((t) => t.tag);
    const hashtagCasings = hashtagTokens.map((t) => t.variant);
    const topics = body ? inferTopicsFromText(body, { hashtags, relatedTopics: [] }) : [];
    return { topics, hashtags, hashtagCasings };
  }

  /**
   * Validate and normalize draft media (same rules as createPost, shared by
   * createDraft/updateDraft): upload keys must live under the user's prefix
   * (or be a known content-hash reuse), Giphy items must carry a URL.
   */
  private async cleanMediaItems(userId: string, media: DraftMediaInput[]): Promise<CleanedDraftMedia[]> {
    const allowedImagePrefixes = [`uploads/${userId}/images/`, `dev/uploads/${userId}/images/`];
    const allowedVideoPrefixes = [`uploads/${userId}/videos/`, `dev/uploads/${userId}/videos/`];
    const allowedThumbnailPrefixes = [`uploads/${userId}/thumbnails/`, `dev/uploads/${userId}/thumbnails/`];
    const uploadKeys = media
      .filter((m) => m.source === 'upload' && (m.r2Key ?? '').trim())
      .map((m) => (m.r2Key ?? '').trim());
    const reusedKeySet = new Set(
      uploadKeys.length
        ? (await this.prisma.mediaContentHash.findMany({ where: { r2Key: { in: uploadKeys } }, select: { r2Key: true } })).map((r) => r.r2Key)
        : [],
    );
    return media
      .map((m, idx): CleanedDraftMedia => {
        const source = m.source;
        const kind = m.kind;
        const r2Key = (m.r2Key ?? '').trim();
        const thumbnailR2Key = (m.thumbnailR2Key ?? '').trim() || null;
        const url = (m.url ?? '').trim();
        const mp4Url = (m.mp4Url ?? '').trim();
        const width = typeof m.width === 'number' && Number.isFinite(m.width) ? Math.max(1, Math.floor(m.width)) : null;
        const height = typeof m.height === 'number' && Number.isFinite(m.height) ? Math.max(1, Math.floor(m.height)) : null;
        const durationSeconds =
          typeof m.durationSeconds === 'number' && Number.isFinite(m.durationSeconds) && m.durationSeconds >= 0
            ? Math.floor(m.durationSeconds)
            : null;
        const alt = (m.alt ?? '').trim().slice(0, 500) || null;

        if (source === 'upload') {
          if (!r2Key) throw new BadRequestException('Invalid uploaded media key.');
          const isReusedKey = reusedKeySet.has(r2Key);
          if (kind === 'video') {
            if (!isReusedKey && !allowedVideoPrefixes.some((p) => r2Key.startsWith(p))) {
              throw new BadRequestException('Invalid uploaded video key.');
            }
            if (thumbnailR2Key && !allowedThumbnailPrefixes.some((p) => thumbnailR2Key.startsWith(p))) {
              throw new BadRequestException('Invalid thumbnail key.');
            }
            return {
              source,
              kind,
              r2Key,
              thumbnailR2Key: thumbnailR2Key || undefined,
              url: null,
              mp4Url: null,
              width,
              height,
              durationSeconds,
              alt,
              position: idx,
            };
          }
          if (!isReusedKey && !allowedImagePrefixes.some((p) => r2Key.startsWith(p))) {
            throw new BadRequestException('Invalid uploaded media key.');
          }
          return {
            source,
            kind,
            r2Key,
            thumbnailR2Key: undefined,
            url: null,
            mp4Url: null,
            width,
            height,
            durationSeconds: null,
            alt,
            position: idx,
          };
        }

        if (!url) throw new BadRequestException('Invalid Giphy media URL.');
        return {
          source,
          kind,
          r2Key: null,
          thumbnailR2Key: undefined,
          url,
          mp4Url: mp4Url || null,
          width,
          height,
          durationSeconds: null,
          alt,
          position: idx,
        };
      })
      .filter(Boolean);
  }
}
