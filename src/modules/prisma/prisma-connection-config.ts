/** Per-process budget; include every replica and worker when sizing the database. */
export const DEFAULT_PRISMA_CONNECTION_LIMIT = 5;
export const DEFAULT_PRISMA_POOL_TIMEOUT_SECONDS = 10;

export function resolvePrismaConnectionConfig(databaseUrl: string) {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    // A URL parse error can contain the password. Never include the input in errors.
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use PostgreSQL.');
  }

  const positiveInteger = (key: string, fallback: number): number => {
    const values = url.searchParams.getAll(key);
    const raw = values[0];
    if (values.length > 1 || (raw != null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1))) {
      throw new Error(`DATABASE_URL ${key} must be a single positive integer.`);
    }
    const value = raw == null ? fallback : Number(raw);
    url.searchParams.set(key, String(value));
    return value;
  };

  // Prisma's CPU-derived default is not a database memory budget. A small explicit
  // pool also bounds concurrent SQL from HTTP requests and BullMQ consumers.
  const connectionLimit = positiveInteger('connection_limit', DEFAULT_PRISMA_CONNECTION_LIMIT);
  const poolTimeoutSeconds = positiveInteger('pool_timeout', DEFAULT_PRISMA_POOL_TIMEOUT_SECONDS);
  return { url: url.toString(), connectionLimit, poolTimeoutSeconds };
}
