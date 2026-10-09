/** Rows that are not soft-deleted. Spread into a where clause or a relation filter (`some`, `is`, nested). */
export const NOT_DELETED = { deletedAt: null } as const;
