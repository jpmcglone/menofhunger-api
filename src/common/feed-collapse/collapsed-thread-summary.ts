import type { FeedCollapsedItem } from './collapse-by-root';

type ChainNode = { id: string; parent?: ChainNode };

type CollapsibleDto<A> = ChainNode & {
  threadCollapsedCount?: number;
  threadCollapsedAuthors?: A[];
};

/** Ids a client renders for this row: the post itself plus its hydrated ancestors. */
export function renderedChainIds(dto: ChainNode): Set<string> {
  const ids = new Set<string>();
  let cursor: ChainNode | undefined = dto;
  while (cursor?.id && !ids.has(cursor.id)) {
    ids.add(cursor.id);
    cursor = cursor.parent;
  }
  return ids;
}

/**
 * Stamp `threadCollapsedCount` / `threadCollapsedAuthors` for a feed row.
 *
 * Collapsed items that appear in the row's hydrated ancestor chain are excluded:
 * they render as rows inside this very thread (either directly or behind the
 * client's collapsed-ancestor connector, which labels itself separately), so
 * counting them would point the viewer at replies already on screen. What is left
 * is exactly the set of same-thread feed items this row does not show.
 */
export function applyCollapsedThreadSummary<A extends { id: string }>(
  dto: CollapsibleDto<A>,
  collapsed: FeedCollapsedItem<A>[] | undefined,
): void {
  if (!collapsed?.length) return;

  const rendered = renderedChainIds(dto);
  const hidden = collapsed.filter((item) => !rendered.has(item.id));
  if (hidden.length === 0) return;

  dto.threadCollapsedCount = hidden.length;

  const authors: A[] = [];
  const seenAuthorIds = new Set<string>();
  for (const item of hidden) {
    const author = item.author;
    if (!author?.id || seenAuthorIds.has(author.id)) continue;
    seenAuthorIds.add(author.id);
    authors.push(author);
  }
  if (authors.length > 0) dto.threadCollapsedAuthors = authors;
}
