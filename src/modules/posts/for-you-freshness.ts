/** Input is already relevance-ranked with the cursor's stable random seed. */
export function selectFreshForYou<T extends { candidate: { id: string; userId: string; parentId: string | null } }>(
  ranked: T[],
  options: {
    limit: number;
    seenById: ReadonlyMap<string, { lastSeenAt: Date }>;
    hasNewReplies: (id: string) => boolean;
    authorWindow: number;
  },
): T[] {
  const unseen: T[] = [];
  const updated: T[] = [];
  const repeats: T[] = [];
  for (const row of ranked) {
    if (!options.seenById.has(row.candidate.id)) unseen.push(row);
    else if (options.hasNewReplies(row.candidate.id)) updated.push(row);
    else repeats.push(row);
  }
  // Rotate exhausted feeds toward the least recently seen hour. Within an hour,
  // relevance + seeded jitter breaks ties without changing during pagination.
  repeats.sort((a, b) => Math.floor(options.seenById.get(a.candidate.id)!.lastSeenAt.getTime() / 3_600_000)
    - Math.floor(options.seenById.get(b.candidate.id)!.lastSeenAt.getTime() / 3_600_000));
  const picked: T[] = [];
  const ids = new Set<string>();
  const recentAuthors: string[] = [];
  const recentRoots: string[] = [];
  const recentReplies: boolean[] = [];
  for (const [tier, cap] of [[unseen, options.limit], [updated, 2], [repeats, options.limit]] as const) {
    let count = 0;
    const skipped: T[] = [];
    const append = (row: T) => {
      if (ids.has(row.candidate.id) || picked.length >= options.limit || count >= cap) return;
      picked.push(row);
      ids.add(row.candidate.id);
      count++;
      recentAuthors.push(row.candidate.userId);
      recentRoots.push(row.candidate.parentId ?? row.candidate.id);
      recentReplies.push(Boolean(row.candidate.parentId));
      if (recentReplies.length >= 3) recentReplies.shift();
      if (recentAuthors.length >= options.authorWindow) recentAuthors.shift();
      if (recentRoots.length >= options.authorWindow) recentRoots.shift();
    };
    for (const row of tier) {
      if (recentAuthors.includes(row.candidate.userId) || recentRoots.includes(row.candidate.parentId ?? row.candidate.id) || (row.candidate.parentId && recentReplies.includes(true) && tier.some(r => !r.candidate.parentId && !ids.has(r.candidate.id)))) skipped.push(row);
      else append(row);
    }
    // Never promote a repeat merely to satisfy author diversity.
    for (const row of skipped) append(row);
  }
  return picked;
}
