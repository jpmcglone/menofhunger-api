import type { Post, PostMedia, PostMediaKind, PostMediaSource, PostVisibility, User, VerifiedStatus } from '@prisma/client';
import { publicAssetUrl } from '../../common/assets/public-asset-url';

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
  width: number | null;
  height: number | null;
  // When present, the media was hard-deleted from storage and should render as a placeholder.
  deletedAt: string | null;
};

export type PostMentionDto = {
  id: string;
  username: string;
};

export type PostDto = {
  id: string;
  createdAt: string;
  body: string;
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
  };
  author: PostAuthorDto;
};

type PostMentionWithUser = { user: { id: string; username: string | null } };
type PostWithAuthorAndMedia = Post & {
  user: User;
  media: PostMedia[];
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
      boostScore: number | null;
      boostScoreUpdatedAt: Date | null;
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

  const media: PostMediaDto[] = (post.media ?? [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((m) => {
      const deletedAt = (m as any).deletedAt ? ((m as any).deletedAt as Date).toISOString() : (m as any).deletedAt ?? null;
      const isDeleted = Boolean(deletedAt);

      const url = isDeleted
        ? ''
        : m.source === 'upload'
          ? publicAssetUrl({
              publicBaseUrl: publicAssetBaseUrl,
              key: m.r2Key ?? null,
            })
          : (m.url ?? '').trim();
      return {
        id: m.id,
        kind: m.kind,
        source: m.source,
        url: url || '',
        mp4Url: m.mp4Url ?? null,
        width: typeof (m as any).width === 'number' ? ((m as any).width as number) : m.width ?? null,
        height: typeof (m as any).height === 'number' ? ((m as any).height as number) : m.height ?? null,
        deletedAt: deletedAt || null,
      };
    })
    .filter((m) => Boolean(m.url) || Boolean(m.deletedAt));

  const mentions: PostMentionDto[] = ((post as any).mentions ?? [])
    .map((m: PostMentionWithUser) =>
      m.user?.id != null && m.user?.username != null
        ? { id: m.user.id, username: m.user.username }
        : null,
    )
    .filter(Boolean);

  return {
    id: post.id,
    createdAt: post.createdAt.toISOString(),
    body: post.body,
    visibility: post.visibility,
    boostCount: post.boostCount,
    bookmarkCount: (post as any).bookmarkCount ?? 0,
    commentCount: (post as any).commentCount ?? 0,
    parentId: (post as any).parentId ?? null,
    mentions,
    media,
    ...(typeof opts?.viewerHasBoosted === 'boolean' ? { viewerHasBoosted: opts.viewerHasBoosted } : {}),
    ...(typeof opts?.viewerHasBookmarked === 'boolean' ? { viewerHasBookmarked: opts.viewerHasBookmarked } : {}),
    ...(Array.isArray(opts?.viewerBookmarkCollectionIds) ? { viewerBookmarkCollectionIds: opts.viewerBookmarkCollectionIds } : {}),
    ...(opts?.includeInternal
      ? {
          internal: {
            boostScore: internalBoostScore,
            boostScoreUpdatedAt: internalBoostScoreUpdatedAt ? internalBoostScoreUpdatedAt.toISOString() : null,
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

