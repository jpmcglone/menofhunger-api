export type FeedCollapseMode = 'root' | 'parent';
export type FeedCollapsePrefer = 'reply' | 'root';

export type FeedCollapseOptions<T, A = never> = {
  collapseByRoot: boolean;
  collapseMode?: FeedCollapseMode;
  prefer?: FeedCollapsePrefer;
  /** Maximum number of items to keep per root group (default 1). */
  maxPerRoot?: number;
  getId: (item: T) => string | null | undefined;
  getParentId: (item: T) => string | null | undefined;
  /** When set, an author preview is captured for each collapsed item. */
  getAuthorPreview?: (item: T) => A | null;
};

/** A feed item that was grouped into a kept row's thread but not returned. */
export type FeedCollapsedItem<A> = { id: string; author: A | null };

export type FeedCollapseResult<T, A = never> = {
  items: T[];
  /**
   * For each kept item's id: the same-thread feed items that were NOT returned.
   *
   * These are *candidates* for a "View N more replies" footer, not the final count.
   * A collapsed item that still renders as part of the kept row's hydrated ancestor
   * chain must not be counted — see `applyCollapsedThreadSummary`, which does that
   * filtering once the chain is known.
   */
  collapsedItemsByItemId: Map<string, FeedCollapsedItem<A>[]>;
};

function normalizeId(value: string | null | undefined): string | null {
  const id = (value ?? '').trim();
  return id ? id : null;
}

/**
 * Collapse a post-like feed to at most maxPerRoot rows per root thread while
 * preserving the original stream ordering of first-seen root keys.
 *
 * - collapseMode='root': group by top-most in-set ancestor (full thread root).
 * - collapseMode='parent': group by immediate parent when available.
 * - maxPerRoot=1: single winner per group; `prefer` decides reply-vs-root ties.
 * - maxPerRoot>1: keep the deepest item in the group plus its in-set ancestors.
 *
 * Why "deepest plus its ancestors" rather than "first N in feed order": clients
 * render one row per thread root, anchored on the deepest returned item, with its
 * ancestors hydrated into the row. So a returned item only earns its slot when it
 * is an ancestor of that anchor (it renders as a pinned row in the chain). A
 * returned sibling branch would render nowhere — it is collapsed instead, which
 * costs one DTO less and still surfaces through the footer count and facepile.
 */
export function collapseFeedByRoot<T, A = never>(
  items: T[],
  options: FeedCollapseOptions<T, A>,
): FeedCollapseResult<T, A> {
  if (!options.collapseByRoot) {
    return { items, collapsedItemsByItemId: new Map() };
  }

  const collapseMode = options.collapseMode ?? 'root';
  const prefer = options.prefer ?? 'reply';
  const maxN = Math.max(1, options.maxPerRoot ?? 1);
  const getId = options.getId;
  const getParentId = options.getParentId;

  const byId = new Map<string, T>();
  for (const item of items) {
    const id = normalizeId(getId(item));
    if (!id) continue;
    byId.set(id, item);
  }

  function groupKeyFor(item: T): string | null {
    const id = normalizeId(getId(item));
    if (!id) return null;
    const parentId = normalizeId(getParentId(item));

    if (collapseMode === 'parent') {
      return parentId ?? id;
    }

    let currentId: string | null = id;
    let rootId: string = id;
    while (currentId) {
      rootId = currentId;
      const current = byId.get(currentId);
      if (!current) break;
      currentId = normalizeId(getParentId(current));
    }
    return rootId;
  }

  /** Ids of the item's ancestors that are themselves in the feed, nearest first. */
  function inSetAncestorIds(item: T): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let cursor = normalizeId(getParentId(item));
    while (cursor && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      out.push(cursor);
      cursor = normalizeId(getParentId(byId.get(cursor) as T));
    }
    return out;
  }

  function shouldReplace(existing: T, candidate: T): boolean {
    const existingIsReply = Boolean(normalizeId(getParentId(existing)));
    const candidateIsReply = Boolean(normalizeId(getParentId(candidate)));
    if (prefer === 'reply') return !existingIsReply && candidateIsReply;
    return existingIsReply && !candidateIsReply;
  }

  /** The item whose rendered chain is deepest; feed order breaks ties. */
  function anchorOf(group: T[]): T {
    let anchor: T = group[0] as T;
    let anchorDepth = inSetAncestorIds(anchor).length;
    for (const candidate of group.slice(1)) {
      const depth = inSetAncestorIds(candidate).length;
      if (depth > anchorDepth) {
        anchor = candidate;
        anchorDepth = depth;
      }
    }
    return anchor;
  }

  function keptIdsFor(group: T[]): Set<string> {
    if (maxN === 1) {
      let winner: T = group[0] as T;
      for (const candidate of group.slice(1)) {
        if (shouldReplace(winner, candidate)) winner = candidate;
      }
      return new Set([normalizeId(getId(winner)) ?? '']);
    }

    const anchor = anchorOf(group);
    const kept = new Set([normalizeId(getId(anchor)) ?? '']);
    const groupIds = new Set(group.map((item) => normalizeId(getId(item))));
    for (const ancestorId of inSetAncestorIds(anchor)) {
      if (kept.size >= maxN) break;
      if (groupIds.has(ancestorId)) kept.add(ancestorId);
    }
    return kept;
  }

  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const item of items) {
    const key = groupKeyFor(item);
    if (!key) continue;
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
      order.push(key);
    }
  }

  const keptItems: T[] = [];
  const collapsedItemsByItemId = new Map<string, FeedCollapsedItem<A>[]>();

  for (const key of order) {
    const group = groups.get(key) ?? [];
    if (group.length === 1) {
      keptItems.push(group[0]!);
      continue;
    }

    const keptIds = keptIdsFor(group);
    const kept: T[] = [];
    const collapsed: FeedCollapsedItem<A>[] = [];
    for (const item of group) {
      const id = normalizeId(getId(item));
      if (id && keptIds.has(id)) {
        kept.push(item);
      } else if (id) {
        collapsed.push({ id, author: options.getAuthorPreview?.(item) ?? null });
      }
    }

    keptItems.push(...kept);
    if (collapsed.length > 0) {
      for (const item of kept) {
        const id = normalizeId(getId(item));
        if (id) collapsedItemsByItemId.set(id, collapsed);
      }
    }
  }

  return { items: keptItems, collapsedItemsByItemId };
}
