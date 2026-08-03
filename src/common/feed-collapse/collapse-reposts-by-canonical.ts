import type { PostAuthorDto } from '../dto/post.dto';

export type RepostCollapseItem = {
  id: string;
  kind?: string | null;
  repostedPostId?: string | null;
  createdAt: Date;
};

export type RepostCollapseResult<T extends RepostCollapseItem> = {
  /** Feed rows after collapsing multi-reposter rows and removing co-page originals. */
  items: T[];
  /**
   * For each surviving repost shell id:
   *   - `authors`: all reposting authors in feed order (newest first), capped at 5.
   *     Present only when ≥ 2 rows were collapsed.
   *   - `count`: total number of repost rows collapsed into this one.
   *     Present only when > 1.
   */
  repostedByAuthorsByItemId: Map<string, PostAuthorDto[]>;
  repostedByCountByItemId: Map<string, number>;
};

/**
 * Collapse multiple flat-repost rows that reference the same canonical post into
 * a single surviving row (the newest repost chronologically).
 *
 * Also removes a co-page original when at least one of its reposts is present —
 * the repost shell already embeds the original content, so the original row would
 * just duplicate it.
 *
 * Returns the collapsedBy authors and count for UI ("Alice and 3 others reposted").
 * `authors` and `count` are only set when ≥ 2 rows were collapsed into one.
 */
export function collapseRepostsByCanonical<T extends RepostCollapseItem>(
  posts: T[],
  getAuthorPreview: (item: T) => PostAuthorDto | null,
  viewerFollowingIds?: Set<string>,
): RepostCollapseResult<T> {
  // Group repost rows by canonical (repostedPostId).
  const repostGroupsByCanonical = new Map<string, T[]>();
  for (const post of posts) {
    if (post.kind === 'repost' && post.repostedPostId) {
      const group = repostGroupsByCanonical.get(post.repostedPostId) ?? [];
      group.push(post);
      repostGroupsByCanonical.set(post.repostedPostId, group);
    }
  }

  // IDs of originals that are already embedded inside a repost row.
  const repostedOriginalIds = new Set<string>(repostGroupsByCanonical.keys());

  // For each canonical original: the newest repost shell is the survivor.
  const survivorIdByCanonical = new Map<string, string>();
  const repostedByAuthorsByItemId = new Map<string, PostAuthorDto[]>();
  const repostedByCountByItemId = new Map<string, number>();

  for (const [canonicalId, group] of repostGroupsByCanonical) {
    // Sort newest first (largest createdAt).
    const sorted = group.slice().sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const survivor = sorted[0]!;
    survivorIdByCanonical.set(canonicalId, survivor.id);

    if (sorted.length >= 2) {
      // Collect authors: followed accounts first, then chronological remainder.
      const authors = sorted.map((p) => getAuthorPreview(p)).filter((a): a is PostAuthorDto => a !== null);
      const following = authors.filter((a) => viewerFollowingIds?.has(a.id));
      const rest = authors.filter((a) => !viewerFollowingIds?.has(a.id));
      const ordered = [...following, ...rest].slice(0, 5);
      repostedByAuthorsByItemId.set(survivor.id, ordered);
      repostedByCountByItemId.set(survivor.id, sorted.length);
    }
  }

  // Build the filtered list:
  //   - For each group: keep only the survivor repost row.
  //   - Remove the standalone original when a repost of it is present.
  const items = posts.filter((post) => {
    // Drop non-survivor repost rows for the same original.
    if (post.kind === 'repost' && post.repostedPostId) {
      const survivorId = survivorIdByCanonical.get(post.repostedPostId);
      return survivorId === post.id;
    }
    // Drop standalone originals that are already embedded in a repost.
    if (repostedOriginalIds.has(post.id)) return false;
    return true;
  });

  return { items, repostedByAuthorsByItemId, repostedByCountByItemId };
}
