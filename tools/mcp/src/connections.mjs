// Per-person index of hosted MCP connections. Grants themselves stay encrypted and
// keyed by a hash of the grant ID; the index holds only that hash and display metadata,
// so listing never exposes a token and a connection ID cannot be used as a credential.
const INDEX_TTL = 31 * 86400;
const indexKey = (userId) => `moh:mcp:oauth:user:${userId}`;
const usedKey = (userId) => `moh:mcp:oauth:user-used:${userId}`;

export const CONNECTION_ID = /^[a-f0-9]{64}$/;

export async function recordConnection(redis, userId, connectionId, { clientName, audience }) {
  await redis.hset(indexKey(userId), connectionId,
    JSON.stringify({ clientName, audience, createdAt: new Date().toISOString() }));
  await redis.expire(indexKey(userId), INDEX_TTL);
}

export async function touchConnection(redis, userId, connectionId) {
  await redis.hset(usedKey(userId), connectionId, new Date().toISOString());
  await redis.expire(usedKey(userId), INDEX_TTL);
}

export async function forgetConnection(redis, userId, connectionId) {
  await redis.hdel(indexKey(userId), connectionId);
  await redis.hdel(usedKey(userId), connectionId);
}

/** Connections that still have a live grant for this MCP endpoint, newest first. */
export async function listConnections(store, userId, resourceUrl) {
  const [rows, used] = await Promise.all([
    store.redis.hgetall(indexKey(userId)),
    store.redis.hgetall(usedKey(userId)),
  ]);
  const connections = [];
  for (const [id, raw] of Object.entries(rows ?? {})) {
    const grant = CONNECTION_ID.test(id) ? await store.getByDigest('grant', id) : null;
    if (!grant) {
      await forgetConnection(store.redis, userId, id);
      continue;
    }
    // Another environment sharing Redis owns this grant; leave it alone.
    if (grant.resourceUrl !== resourceUrl || grant.userId !== userId) continue;
    let meta = {};
    try { meta = JSON.parse(raw); } catch { /* Metadata is display-only. */ }
    connections.push({
      id,
      clientName: typeof meta.clientName === 'string' && meta.clientName ? meta.clientName : 'MCP client',
      audience: grant.audience === 'member' ? 'member' : 'admin',
      createdAt: meta.createdAt ?? null,
      lastUsedAt: used?.[id] ?? null,
      expiresAt: new Date(grant.expiresAt * 1000).toISOString(),
    });
  }
  return connections.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Ends one connection: its grant, every token issued from it, and its dedicated session. */
export async function revokeConnection(store, { userId, connectionId, resourceUrl, revokeSession }) {
  if (!CONNECTION_ID.test(connectionId)) return false;
  const grant = await store.getByDigest('grant', connectionId);
  if (!grant || grant.userId !== userId || grant.resourceUrl !== resourceUrl) {
    if (!grant) await forgetConnection(store.redis, userId, connectionId);
    return false;
  }
  // Session first: if it fails, the grant stays listed for a retry and is already unusable.
  await revokeSession(grant.sessionToken);
  await store.removeByDigest('grant', connectionId);
  await forgetConnection(store.redis, userId, connectionId);
  return true;
}
