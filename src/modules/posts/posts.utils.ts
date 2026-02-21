import type { Post } from '@prisma/client';
import type { PostWithAuthorAndMedia } from './post.dto';

type PostWithParentId = { id: string; parentId?: string | null } & Record<string, unknown>;

/**
 * Build a recursive mapper that attaches parent chain to each post DTO.
 * Used by list() and listForUser() to avoid duplicating the attachParentChain logic.
 */
export function buildAttachParentChain<T extends PostWithParentId>(opts: {
  parentMap: Map<string, Post | T>;
  baseUrl: string | null;
  boosted: Set<string>;
  bookmarksByPostId: Map<string, { collectionIds: string[] }>;
  votedPollOptionIdByPostId: Map<string, string>;
  viewerHasAdmin: boolean;
  internalByPostId: Map<string, { boostScore?: number | null; boostScoreUpdatedAt?: Date | null; score?: number | null }> | null;
  scoreByPostId: Map<string, number> | undefined;
  toPostDto: typeof import('./post.dto').toPostDto;
  /** Author IDs the viewer has blocked. */
  blockedByViewer?: Set<string>;
  /** Author IDs that have blocked the viewer. */
  viewerBlockedBy?: Set<string>;
}) {
  const {
    parentMap,
    baseUrl,
    boosted,
    bookmarksByPostId,
    votedPollOptionIdByPostId,
    viewerHasAdmin,
    internalByPostId,
    scoreByPostId,
    toPostDto,
    blockedByViewer,
    viewerBlockedBy,
  } = opts;

  function attachParentChain(post: T): ReturnType<typeof toPostDto> & { parent?: ReturnType<typeof toPostDto> } {
    const internalOverride = internalByPostId?.get(post.id);
    const score = scoreByPostId?.get(post.id);
    const authorId = (post as any).user?.id ?? (post as any).userId ?? null;
    const viewerBlockStatus =
      authorId && blockedByViewer?.has(authorId)
        ? 'viewer_blocked'
        : authorId && viewerBlockedBy?.has(authorId)
          ? 'viewer_blocked_by'
          : null;
    const dto = toPostDto(post as unknown as PostWithAuthorAndMedia, baseUrl, {
      viewerHasBoosted: boosted.has(post.id),
      viewerHasBookmarked: bookmarksByPostId.has(post.id),
      viewerBookmarkCollectionIds: bookmarksByPostId.get(post.id)?.collectionIds ?? [],
      viewerVotedPollOptionId: votedPollOptionIdByPostId.get(post.id) ?? null,
      viewerBlockStatus: viewerBlockStatus ?? undefined,
      includeInternal: viewerHasAdmin,
      internalOverride:
        internalOverride || (typeof score === 'number' ? { score } : undefined)
          ? { ...internalOverride, ...(typeof score === 'number' ? { score } : {}) }
          : undefined,
    }) as ReturnType<typeof toPostDto> & { parent?: ReturnType<typeof toPostDto> };
    const parent = post.parentId ? parentMap.get(post.parentId) : null;
    if (parent) {
      dto.parent = attachParentChain(parent as T);
    }
    return dto;
  }

  return attachParentChain;
}
