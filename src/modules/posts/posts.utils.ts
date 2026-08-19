import type { Post } from '@prisma/client';
import type { CommunityGroupPreviewDto } from '../../common/dto/community-group.dto';
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
  /** Set of post IDs that the viewer has viewed (used for viewerHasViewed flag). */
  viewedByPostId?: Set<string>;
  /** Viewer's lastSeenAt per viewed post (ISO-stamped as viewerLastSeenAt). */
  lastSeenAtByPostId?: Map<string, Date>;
  /** Map from repostedPostId to the raw post data for flat reposts. */
  repostedPostMap?: Map<string, T>;
  /**
   * Map from quotedPostId to viewer-gated post data for quote-post cards.
   * When present, this map is authoritative: a missing entry means the viewer
   * cannot access the quoted post and the quotedPost DTO is omitted.
   * Falls back to the raw Prisma include when this map is absent (single-post paths).
   */
  quotedPostMap?: Map<string, T>;
  /** When set, used to determine per-post viewerCanAccess. Posts not in the map default to true. */
  viewerCanAccessByPostId?: Map<string, boolean>;
  /** Join previews for posts scoped to a community group (inline chip + hover card). */
  groupPreviewByGroupId?: Map<string, CommunityGroupPreviewDto>;
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
    quotedPostMap,
    viewerCanAccessByPostId,
    groupPreviewByGroupId,
    viewedByPostId,
    lastSeenAtByPostId,
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

    // For posts with an embedded quoted-post link, build the DTO via the viewer-gated
    // quotedPostMap (populated by getByIds on the feed path).  A map miss means the viewer
    // cannot access that post; omit quotedPost so the client shows "Post unavailable".
    // Single-post paths that don't supply quotedPostMap fall back to the raw Prisma include
    // so they keep working without the full feed plumbing.
    const quotedPostIdVal = (post as any).quotedPostId as string | null | undefined;
    let quotedPostDto: ReturnType<typeof toPostDto> | undefined;
    if (quotedPostMap && quotedPostIdVal) {
      // Feed path: use the viewer-gated map; absence = gated out.
      const quotedFromMap = quotedPostMap.get(quotedPostIdVal);
      quotedPostDto = quotedFromMap ? (attachParentChain(quotedFromMap) as ReturnType<typeof toPostDto>) : undefined;
    } else {
      // Single-post / legacy path: fall back to the raw Prisma include.
      const quotedPostRaw = (post as any).quotedPost ?? null;
      quotedPostDto = quotedPostRaw
        ? toPostDto(quotedPostRaw as PostWithAuthorAndMedia, baseUrl)
        : undefined;
    }

    const postViewerCanAccess = viewerCanAccessByPostId ? (viewerCanAccessByPostId.get(post.id) ?? true) : undefined;

    const gid = String((post as { communityGroupId?: string | null }).communityGroupId ?? '').trim();
    const groupPreview = gid ? groupPreviewByGroupId?.get(gid) : undefined;

    const dto = toPostDto(post as unknown as PostWithAuthorAndMedia, baseUrl, {
      viewerHasBoosted: boosted.has(post.id),
      viewerHasBookmarked: bookmarksByPostId.has(post.id),
      viewerBookmarkCollectionIds: bookmarksByPostId.get(post.id)?.collectionIds ?? [],
      viewerVotedPollOptionId: votedPollOptionIdByPostId.get(post.id) ?? null,
      viewerCreatorSkipped: viewerCreatorSkipped || undefined,
      viewerBlockStatus: viewerBlockStatus ?? undefined,
      viewerHasReposted: repostedByPostId ? repostedByPostId.has(post.id) : undefined,
      viewerHasViewed: viewedByPostId ? viewedByPostId.has(post.id) : undefined,
      viewerLastSeenAt: lastSeenAtByPostId?.get(post.id)?.toISOString(),
      repostedPost: repostedPostDto,
      quotedPost: quotedPostDto,
      includeInternal: viewerHasAdmin,
      internalOverride:
        internalOverride || (typeof score === 'number' ? { score } : undefined)
          ? { ...internalOverride, ...(typeof score === 'number' ? { score } : {}) }
          : undefined,
      viewerCanAccess: postViewerCanAccess,
      ...(groupPreview ? { groupPreview } : {}),
    }) as ReturnType<typeof toPostDto> & { parent?: ReturnType<typeof toPostDto> };
    const parent = post.parentId ? parentMap.get(post.parentId) : null;
    if (parent) {
      dto.parent = attachParentChain(parent as T);
    }
    return dto;
  }

  return attachParentChain;
}
