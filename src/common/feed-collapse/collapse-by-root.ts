export type FeedCollapseMode = 'root' | 'parent';
export type FeedCollapsePrefer = 'reply' | 'root';

export type FeedCollapseOptions<T> = {
  collapseByRoot: boolean;
  collapseMode?: FeedCollapseMode;
  prefer?: FeedCollapsePrefer;
  getId: (item: T) => string | null | undefined;
  getParentId: (item: T) => string | null | undefined;
};

function normalizeId(value: string | null | undefined): string | null {
  const id = (value ?? '').trim();
  return id ? id : null;
}

/**
 * Collapse a post-like feed to one row per root thread while preserving the
 * original stream ordering of first-seen root keys.
 *
 * - collapseMode='root': group by top-most in-set ancestor (full thread root).
 * - collapseMode='parent': group by immediate parent when available.
 * - prefer='reply': when two rows share a group key, prefer a reply over root.
 * - prefer='root': when two rows share a group key, prefer the root/non-reply.
 */
export function collapseFeedByRoot<T>(items: T[], options: FeedCollapseOptions<T>): T[] {
  if (!options.collapseByRoot) return items;

  const collapseMode = options.collapseMode ?? 'root';
  const prefer = options.prefer ?? 'reply';
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

  const selectedByKey = new Map<string, T>();
  const order: string[] = [];

  for (const item of items) {
    const key = groupKeyFor(item);
    if (!key) continue;
    const existing = selectedByKey.get(key);
    if (!existing) {
      selectedByKey.set(key, item);
      order.push(key);
      continue;
    }
    if (shouldReplace(existing, item)) {
      selectedByKey.set(key, item);
    }
  }

  return order
    .map((key) => selectedByKey.get(key))
    .filter((item): item is T => Boolean(item));
}

