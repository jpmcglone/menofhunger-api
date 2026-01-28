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
  author: PostAuthorDto;
};

type PostWithAuthor = Post & { user: User };

export function toPostDto(post: PostWithAuthor, publicAssetBaseUrl: string | null = null): PostDto {
  return {
    id: post.id,
    createdAt: post.createdAt.toISOString(),
    body: post.body,
    visibility: post.visibility,
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

