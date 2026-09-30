/**
 * Failures we raise on purpose and already surface to the user are not Sentry issues:
 *  - Client-error `HttpException`s (4xx) carry a user-facing message and go through the global
 *    exception filter, plus the 503s we return when an upstream provider is briefly unavailable.
 *  - `PickaxApiError` is a third-party rejection; we store it on the post/article and in Settings,
 *    and the queue retries on its own.
 *
 * Every other 5xx still reports, including one we raise ourselves: a deliberate
 * `InternalServerErrorException` means our own code hit a state it could not handle, which is
 * exactly the signal worth an issue. Unexpected bugs (TypeError, Prisma errors, and anything
 * else) report normally.
 *
 * Lives outside `instrument.ts` so it can be tested without running `Sentry.init`.
 */
export function isExpectedFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { getStatus?: unknown; constructor?: { name?: string } };
  if (typeof candidate.getStatus === 'function') {
    const status = Number((candidate.getStatus as () => unknown)());
    if (!Number.isFinite(status)) return false;
    return status < 500 || status === 503;
  }
  return candidate.constructor?.name === 'PickaxApiError';
}
