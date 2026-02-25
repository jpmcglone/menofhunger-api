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
  viewerUserId: string | null;
  viewerHasAdmin: boolean;
  internalByPostId: Map<string, { boostScore?: number | null; boostScoreUpdatedAt?: Date | null; score?: number | null }> | null;
  scoreByPostId: Map<string, number> | undefined;
  toPostDto: typeof import('./post.dto').toPostDto;
  /** Author IDs the viewer has blocked. */
  blockedByViewer?: Set<string>;
  /** Author IDs that have blocked the viewer. */
  viewerBlockedBy?: Set<string>;
  /** Set of canonical post IDs that the viewer has flat-reposted. */
  repostedByPostId?: Set<string>;
  /** Map from repostedPostId to the raw post data for flat reposts. */
  repostedPostMap?: Map<string, T>;
}) {
  const {
    parentMap,
    baseUrl,
    boosted,
    bookmarksByPostId,
    votedPollOptionIdByPostId,
    viewerUserId,
    viewerHasAdmin,
    internalByPostId,
    scoreByPostId,
    toPostDto,
    blockedByViewer,
    viewerBlockedBy,
    repostedByPostId,
    repostedPostMap,
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
    const postWithPoll = post as { user?: { id?: string }; poll?: { creatorSkippedAt?: Date | null } };
    const viewerCreatorSkipped =
      Boolean(viewerUserId) &&
      postWithPoll.user?.id === viewerUserId &&
      Boolean(postWithPoll.poll?.creatorSkippedAt);

    // For flat reposts (kind='repost'), attach the nested reposted post DTO.
    const isRepost = (post as any).kind === 'repost';
    const repostedPostIdVal = isRepost ? ((post as any).repostedPostId as string | null | undefined) : null;
    const repostedPostRaw = repostedPostIdVal ? repostedPostMap?.get(repostedPostIdVal) : undefined;
    const repostedPostDto = repostedPostRaw ? attachParentChain(repostedPostRaw) : undefined;

    const dto = toPostDto(post as unknown as PostWithAuthorAndMedia, baseUrl, {
      viewerHasBoosted: boosted.has(post.id),
      viewerHasBookmarked: bookmarksByPostId.has(post.id),
      viewerBookmarkCollectionIds: bookmarksByPostId.get(post.id)?.collectionIds ?? [],
      viewerVotedPollOptionId: votedPollOptionIdByPostId.get(post.id) ?? null,
      viewerCreatorSkipped: viewerCreatorSkipped || undefined,
      viewerBlockStatus: viewerBlockStatus ?? undefined,
      viewerHasReposted: repostedByPostId ? repostedByPostId.has(post.id) : undefined,
      repostedPost: repostedPostDto,
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
