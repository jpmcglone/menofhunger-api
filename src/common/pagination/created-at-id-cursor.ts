/**
 * Stable pagination for queries ordered by:
 *   createdAt DESC, id DESC
 *
 * Cursor stays a simple `id` string (API contract unchanged). We look up the
 * cursor row to get its createdAt, then apply a deterministic WHERE clause:
 *   createdAt < cursor.createdAt
 *   OR (createdAt = cursor.createdAt AND id < cursor.id)
 */
export async function createdAtIdCursorWhere(params: {
  cursor: string | null;
  lookup: (id: string) => Promise<{ id: string; createdAt: Date } | null>;
}) {
  const cursorId = (params.cursor ?? '').trim();
  if (!cursorId) return null;

  const row = await params.lookup(cursorId);
  if (!row) return null;

  return {
    OR: [
      { createdAt: { lt: row.createdAt } },
      { AND: [{ createdAt: row.createdAt }, { id: { lt: row.id } }] },
    ],
  };
}

