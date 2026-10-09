/** Socket membership strings are `<instanceId>:<socketId>`; keep the format in one place. */
export function memberForSocket(instanceId: string, socketId: string): string {
  return `${instanceId}:${String(socketId ?? '').trim()}`;
}

export function parseSocketMember(member: string): { instanceId: string; socketId: string } | null {
  const m = String(member ?? '').trim();
  const idx = m.indexOf(':');
  if (idx <= 0) return null;
  const inst = m.slice(0, idx).trim();
  const sid = m.slice(idx + 1).trim();
  if (!inst || !sid) return null;
  return { instanceId: inst, socketId: sid };
}

/** TTL fallback should outlive idle-disconnect so crashed instances don't leave users "online" forever. */
export function socketTtlSeconds(idleDisconnectMinutes: number): number {
  const baseMs = idleDisconnectMinutes * 60 * 1000;
  return Math.max(60, Math.ceil((baseMs + 60_000) / 1000));
}

/**
 * Live guests are refreshed every 30s. Kept short so a crashed or `--watch`-restarted API instance
 * cannot leave ghost guests for the full member idle TTL (~15 min).
 */
export const ANON_SOCKET_TTL_SECONDS = 120;
