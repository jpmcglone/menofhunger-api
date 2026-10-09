/** Prisma known-request errors expose a string `code`; mocks and wrapped errors carry the same shape. */
function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

/** P2002: a unique constraint was violated. */
export function isUniqueViolation(err: unknown): boolean {
  return hasCode(err, 'P2002');
}

/** P2025: the record an update/delete targeted does not exist. */
export function isNotFound(err: unknown): boolean {
  return hasCode(err, 'P2025');
}

/** P2034 (or a Postgres message saying so): a serializable transaction conflicted and is safe to retry. */
export function isSerializationFailure(err: unknown): boolean {
  if (hasCode(err, 'P2034')) return true;
  const message = typeof err === 'object' && err !== null ? (err as { message?: unknown }).message : err;
  return /could not serialize access/i.test(String(message ?? ''));
}
