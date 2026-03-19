export type FeedCollapseMode = 'root' | 'parent';
export type FeedCollapsePrefer = 'reply' | 'root';

export type FeedCollapseOptions<T> = {
  collapseByRoot: boolean;
  collapseMode?: FeedCollapseMode;
  prefer?: FeedCollapsePrefer;
  /** Maximum number of items to keep per root group (default 1). */
  maxPerRoot?: number;
  getId: (item: T) => string | null | undefined;
  getParentId: (item: T) => string | null | undefined;
};

export type FeedCollapseResult<T> = {
  items: T[];
  /** How many items were collapsed (not kept) per group key. Only populated for keys where at least 1 item was dropped. */
  collapsedCountByKey: Map<string, number>;
  /**
   * Convenience map: for each kept item's ID, how many other items from the same
   * root group were collapsed. 0 / absent means nothing was collapsed for that group.
   */
  collapsedCountByItemId: Map<string, number>;
};

function normalizeId(value: string | null | undefined): string | null {
  const id = (value ?? '').trim();
  return id ? id : null;
}

/**
 * Collapse a post-like feed to up to maxPerRoot rows per root thread while
 * preserving the original stream ordering of first-seen root keys.
 *
 * - collapseMode='root': group by top-most in-set ancestor (full thread root).
 * - collapseMode='parent': group by immediate parent when available.
 * - prefer='reply': when maxPerRoot=1 and two rows share a group key, prefer a reply over root.
 * - prefer='root': when maxPerRoot=1 and two rows share a group key, prefer the root/non-reply.
 * - maxPerRoot>1: keep up to N items per group in feed-sort order; prefer logic is ignored.
 *
 * Returns both the kept items and a map of how many were collapsed per group key.
 */
export function collapseFeedByRoot<T>(items: T[], options: FeedCollapseOptions<T>): FeedCollapseResult<T> {
  if (!options.collapseByRoot) {
    return { items, collapsedCountByKey: new Map(), collapsedCountByItemId: new Map() };
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

  function shouldReplace(existing: T, candidate: T): boolean {
    const existingIsReply = Boolean(normalizeId(getParentId(existing)));
    const candidateIsReply = Boolean(normalizeId(getParentId(candidate)));
    if (prefer === 'reply') return !existingIsReply && candidateIsReply;
    return existingIsReply && !candidateIsReply;
  }

  // For maxN=1: use the original single-winner logic (shouldReplace).
  // For maxN>1: keep first N in sort order (no prefer logic needed).
  const selectedByKey = new Map<string, T[]>();
  const totalByKey = new Map<string, number>();
  const order: string[] = [];

  for (const item of items) {
    const key = groupKeyFor(item);
    if (!key) continue;

    totalByKey.set(key, (totalByKey.get(key) ?? 0) + 1);

    const existing = selectedByKey.get(key);
    if (!existing) {
      selectedByKey.set(key, [item]);
      order.push(key);
      continue;
    }

    if (maxN === 1) {
      // Original single-winner logic: replace if shouldReplace says to.
      if (shouldReplace(existing[0]!, item)) {
        existing[0] = item;
      }
    } else if (existing.length < maxN) {
      existing.push(item);
    }
  }

  const collapsedCountByKey = new Map<string, number>();
  for (const [key, total] of totalByKey) {
    const kept = selectedByKey.get(key)?.length ?? 0;
    if (total > kept) collapsedCountByKey.set(key, total - kept);
  }

  const keptItems = order.flatMap((key) => selectedByKey.get(key) ?? []);

  // Build per-item-id lookup for convenient controller use.
  const collapsedCountByItemId = new Map<string, number>();
  for (const [key, keptGroup] of selectedByKey) {
    const collapsed = collapsedCountByKey.get(key);
    if (collapsed && collapsed > 0) {
      for (const item of keptGroup) {
        const id = normalizeId(getId(item));
        if (id) collapsedCountByItemId.set(id, collapsed);
      }
    }
  }

  return { items: keptItems, collapsedCountByKey, collapsedCountByItemId };
}
