/** Loosely-typed view of a thrown value (SDK, HTTP, and driver errors differ in shape). Empty for non-objects. */
export function errorFields(err: unknown): { code?: unknown; status?: unknown; message?: unknown; name?: unknown } {
  return typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
}
