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
};

export type PostDto = {
  id: string;
  createdAt: string;
  body: string;
  visibility: PostVisibility;
  boostCount: number;
  media: PostMediaDto[];
  viewerHasBoosted?: boolean;
  internal?: {
    boostScore: number | null;
    boostScoreUpdatedAt: string | null;
  };
  author: PostAuthorDto;
};

type PostWithAuthorAndMedia = Post & { user: User; media: PostMedia[] };

export function toPostDto(
  post: PostWithAuthorAndMedia,
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

  const media: PostMediaDto[] = (post.media ?? [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((m) => {
      const url =
        m.source === 'upload'
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
      };
    })
    .filter((m) => Boolean(m.url));

  return {
    id: post.id,
    createdAt: post.createdAt.toISOString(),
    body: post.body,
    visibility: post.visibility,
    boostCount: post.boostCount,
    media,
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

