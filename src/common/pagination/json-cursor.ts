/** Opaque keyset cursor: a JSON object serialized as base64url. Callers validate the decoded shape. */
export function encodeJsonCursor(payload: object): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Decode a cursor made by `encodeJsonCursor` (standard base64 is also accepted). Null when absent, malformed, or not an object. */
export function decodeJsonCursor(raw: string | null | undefined): Record<string, unknown> | null {
  const token = (raw ?? '').trim();
  if (!token) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
