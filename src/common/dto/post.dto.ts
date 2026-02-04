import type { Post, PostMedia, PostMediaKind, PostMediaSource, PostVisibility, User, VerifiedStatus } from '@prisma/client';
import { publicAssetUrl } from '../assets/public-asset-url';

/** PostMedia from Prisma already has thumbnailR2Key, durationSeconds, width, height, deletedAt. */
export type PostMediaWithOptional = PostMedia;

export type PostAuthorDto = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  verifiedStatus: VerifiedStatus;
  avatarUrl: string | null;
};

export type PostMediaDto = {
  id: string;
  kind: PostMediaKind;
  source: PostMediaSource;
  url: string;
  mp4Url: string | null;
  /** Video poster image URL (from thumbnailR2Key). */
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  /** Video duration in seconds. */
  durationSeconds: number | null;
  /** Optional alt text for accessibility. */
  alt: string | null;
  // When present, the media was hard-deleted from storage and should render as a placeholder.
  deletedAt: string | null;
};

export type PostMentionDto = {
  id: string;
  username: string;
  verifiedStatus?: VerifiedStatus;
  premium?: boolean;
};

export type PostDto = {
  id: string;
  createdAt: string;
  body: string;
  deletedAt: string | null;
  visibility: PostVisibility;
  boostCount: number;
  bookmarkCount: number;
  commentCount: number;
  parentId: string | null;
  /** When present, this post is a reply and the parent is included for thread display. */
  parent?: PostDto;
  mentions: PostMentionDto[];
  media: PostMediaDto[];
  viewerHasBoosted?: boolean;
  viewerHasBookmarked?: boolean;
  viewerBookmarkCollectionIds?: string[];
  internal?: {
    boostScore: number | null;
    boostScoreUpdatedAt: string | null;
    /** Overall popularity score (boost + bookmark + comments, time-decayed). Admin only, from popular feed. */
    score?: number | null;
  };
  author: PostAuthorDto;
};

/** Mention row with user included (from Prisma include). */
export type PostMentionWithUser = {
  user: { id: string; username: string | null; verifiedStatus?: VerifiedStatus; premium?: boolean };
};

/** Post with relations included for DTO mapping. Post has bookmarkCount, commentCount, parentId from schema. */
export type PostWithAuthorAndMedia = Post & {
  user: User;
  media: PostMediaWithOptional[];
  mentions?: PostMentionWithUser[];
};

export function toPostDto(
  post: PostWithAuthorAndMedia,
  publicAssetBaseUrl: string | null = null,
  opts?: {
    viewerHasBoosted?: boolean;
    viewerHasBookmarked?: boolean;
    viewerBookmarkCollectionIds?: string[];
    includeInternal?: boolean;
    internalOverride?: {
      boostScore?: number | null;
      boostScoreUpdatedAt?: Date | null;
      score?: number | null;
    };
  },
): PostDto {
  const internalBoostScore =
    typeof opts?.internalOverride?.boostScore === 'number' || opts?.internalOverride?.boostScore === null
      ? opts.internalOverride.boostScore
      : post.boostScore ?? null;
  const internalBoostScoreUpdatedAt =
    typeof opts?.internalOverride?.boostScoreUpdatedAt !== 'undefined'
      ? opts.internalOverride.boostScoreUpdatedAt
      : post.boostScoreUpdatedAt ?? null;

  const postDeletedAt =
    post.deletedAt instanceof Date ? post.deletedAt.toISOString() : post.deletedAt ? String(post.deletedAt) : null;
  const isPostDeleted = Boolean(postDeletedAt);

  const media: PostMediaDto[] = (post.media ?? [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((m) => {
      const deletedAt = m.deletedAt ? (m.deletedAt instanceof Date ? m.deletedAt.toISOString() : String(m.deletedAt)) : null;
      const isDeleted = Boolean(deletedAt);

      const url = isDeleted
        ? ''
        : m.source === 'upload'
          ? publicAssetUrl({
              publicBaseUrl: publicAssetBaseUrl,
              key: m.r2Key ?? null,
            })
          : (m.url ?? '').trim();
      const thumbnailUrl =
        isDeleted || !m.thumbnailR2Key
          ? null
          : publicAssetUrl({
              publicBaseUrl: publicAssetBaseUrl,
              key: m.thumbnailR2Key,
            });
      const durationSeconds =
        typeof m.durationSeconds === 'number' && Number.isFinite(m.durationSeconds)
          ? Math.max(0, Math.floor(m.durationSeconds))
          : null;
      return {
        id: m.id,
        kind: m.kind,
        source: m.source,
        url: url || '',
        mp4Url: m.mp4Url ?? null,
        thumbnailUrl: thumbnailUrl || null,
        width: typeof m.width === 'number' ? m.width : m.width ?? null,
        height: typeof m.height === 'number' ? m.height : m.height ?? null,
        durationSeconds: durationSeconds ?? null,
        alt: (m.alt ?? '').trim() || null,
        deletedAt: deletedAt || null,
      };
    })
    .filter((m) => Boolean(m.url) || Boolean(m.deletedAt));

  const mentions: PostMentionDto[] = (post.mentions ?? [])
    .map((m: PostMentionWithUser): PostMentionDto | null =>
      m.user?.id != null && m.user?.username != null
        ? {
            id: m.user.id,
            username: m.user.username,
            verifiedStatus: m.user.verifiedStatus ?? undefined,
            premium: m.user.premium ?? undefined,
          }
        : null,
    )
    .filter((x): x is PostMentionDto => x != null);

  return {
    id: post.id,
    createdAt: post.createdAt.toISOString(),
    body: isPostDeleted ? '' : post.body,
    deletedAt: postDeletedAt,
    visibility: post.visibility,
    boostCount: post.boostCount,
    bookmarkCount: post.bookmarkCount ?? 0,
    commentCount: post.commentCount ?? 0,
    parentId: post.parentId ?? null,
    mentions: isPostDeleted ? [] : mentions,
    media: isPostDeleted ? [] : media,
    ...(typeof opts?.viewerHasBoosted === 'boolean' ? { viewerHasBoosted: opts.viewerHasBoosted } : {}),
    ...(typeof opts?.viewerHasBookmarked === 'boolean' ? { viewerHasBookmarked: opts.viewerHasBookmarked } : {}),
    ...(Array.isArray(opts?.viewerBookmarkCollectionIds) ? { viewerBookmarkCollectionIds: opts.viewerBookmarkCollectionIds } : {}),
    ...(opts?.includeInternal
      ? {
          internal: {
            boostScore: internalBoostScore,
            boostScoreUpdatedAt: internalBoostScoreUpdatedAt ? internalBoostScoreUpdatedAt.toISOString() : null,
            ...(typeof opts?.internalOverride?.score === 'number' || opts?.internalOverride?.score === null
              ? { score: opts.internalOverride.score }
              : {}),
          },
        }
      : {}),
    author: {
      id: post.user.id,
      username: post.user.username,
      name: post.user.name,
      premium: post.user.premium,
      verifiedStatus: post.user.verifiedStatus,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: publicAssetBaseUrl,
        key: post.user.avatarKey ?? null,
        updatedAt: post.user.avatarUpdatedAt ?? null,
      }),
    },
  };
}
