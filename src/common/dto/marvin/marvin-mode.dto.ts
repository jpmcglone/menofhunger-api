/**
 * User-facing Marv reply-mode tier. Mirrors the `MarvinMode` Prisma enum but is duplicated
 * here as a literal-string union so it travels cleanly to the web client without leaking
 * Prisma types across the API contract.
 */
export type MarvinModeDto = 'fast' | 'regular' | 'smart';

/** Source channel the request originated from. */
export type MarvinSourceDto = 'public_thread' | 'private_session' | 'catch_up';
