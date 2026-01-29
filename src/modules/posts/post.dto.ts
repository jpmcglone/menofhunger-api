import type { Post, PostVisibility, User, VerifiedStatus } from '@prisma/client';
import { publicAssetUrl } from '../../common/assets/public-asset-url';

export type PostAuthorDto = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  verifiedStatus: VerifiedStatus;
  avatarUrl: string | null;
};

export type PostDto = {
  id: string;
  createdAt: string;
  body: string;
  visibility: PostVisibility;
  boostCount: number;
  viewerHasBoosted?: boolean;
  internal?: {
    boostScore: number | null;
    boostScoreUpdatedAt: string | null;
  };
  author: PostAuthorDto;
};

type PostWithAuthor = Post & { user: User };

export function toPostDto(
  post: PostWithAuthor,
  publicAssetBaseUrl: string | null = null,
  opts?: {
    viewerHasBoosted?: boolean;
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

  return {
    id: post.id,
    createdAt: post.createdAt.toISOString(),
    body: post.body,
    visibility: post.visibility,
    boostCount: post.boostCount,
    ...(typeof opts?.viewerHasBoosted === 'boolean' ? { viewerHasBoosted: opts.viewerHasBoosted } : {}),
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

