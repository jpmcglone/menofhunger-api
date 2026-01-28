import type { Post, PostVisibility, User, VerifiedStatus } from '@prisma/client';

export type PostAuthorDto = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  verifiedStatus: VerifiedStatus;
  avatarKey: string | null;
  avatarUpdatedAt: string | null;
};

export type PostDto = {
  id: string;
  createdAt: string;
  body: string;
  visibility: PostVisibility;
  author: PostAuthorDto;
};

type PostWithAuthor = Post & { user: User };

export function toPostDto(post: PostWithAuthor): PostDto {
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
      avatarKey: post.user.avatarKey ?? null,
      avatarUpdatedAt: post.user.avatarUpdatedAt ? post.user.avatarUpdatedAt.toISOString() : null,
    },
  };
}

