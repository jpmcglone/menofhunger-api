/**
 * When a thread is larger than the prompt budget, keep a window that includes
 * the focal post: as much history before it as fits, then replies after it.
 * Always pin the root in if it would otherwise fall off — Catch me up should
 * still know how the conversation started.
 */
export function windowThreadAroundFocal<T extends { id: string }>(
  rows: T[],
  focalId: string,
  limit: number,
  rootId: string | null,
): T[] {
  if (limit <= 0) return [];
  if (rows.length <= limit) return rows;

  const focalIdx = rows.findIndex((r) => r.id === focalId);
  if (focalIdx < 0) return rows.slice(0, limit);

  const before = rows.slice(0, focalIdx);
  const after = rows.slice(focalIdx + 1);
  const keepBefore = Math.min(before.length, limit - 1);
  const keepAfter = Math.min(after.length, limit - 1 - keepBefore);
  const sliced = [...before.slice(before.length - keepBefore), rows[focalIdx]!, ...after.slice(0, keepAfter)];

  if (rootId && !sliced.some((r) => r.id === rootId)) {
    const root = rows.find((r) => r.id === rootId);
    if (root) {
      const next = [root, ...sliced.filter((r) => r.id !== rootId)];
      if (next.length <= limit) return next;
      const dropIdx = next.findIndex((r, i) => i > 0 && r.id !== focalId);
      if (dropIdx >= 0) next.splice(dropIdx, 1);
      return next.slice(0, limit);
    }
  }
  return sliced;
}
