import { PickaxConnectionService } from './pickax-connection.service';
import { profileVerificationCode } from './pickax-identity';

const key = 'test-only-key';
const token = `header.${Buffer.from(JSON.stringify({ type: 'access', credentialId: 'credential', tokenVersion: 1, iat: 1, exp: 2, aud: 'third-party', iss: 'pickax' })).toString('base64url')}.signature`;

describe('Pickax credentials reconnect', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  function harness(current: any = null) {
    const upsert = jest.fn(async ({ create, update }) => ({ ...current, ...(current ? update : create) }));
    const updateMany = jest.fn();
    const prisma: any = {
      pickaxConnection: { findUnique: jest.fn(async () => current), findFirst: jest.fn(async () => null), upsert, updateMany },
      user: { update: jest.fn(async () => ({})), findUnique: jest.fn(async () => null) },
      $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    };
    const service = new PickaxConnectionService(prisma, { pickaxSecretEncryptionKey: () => key } as any,
      { exchangeCredentials: jest.fn(async () => ({ accessToken: token, refreshToken: 'refresh', expiresInSeconds: 3600, responseKeys: ['accessToken'] })) } as any,
      {} as any, { emitPublicProfileUpdated: jest.fn() } as any, { emitMeUpdated: jest.fn() } as any,
      { available: () => false } as any, {} as any);
    return { service, upsert, updateMany, prisma };
  }
  function profile(text: string) { global.fetch = jest.fn(async () => new Response(text)) as any; }
  it('requires ownership proof before saving a token without account claims', async () => {
    profile('@alice');
    const h = harness();
    const result = await h.service.connect('member', { clientId: 'key', clientSecret: 'secret', username: 'alice' });
    expect(result.needsUsername).toBe(true);
    expect(result.verificationCode).toBe(profileVerificationCode('member', 'alice', key));
    expect(h.upsert).not.toHaveBeenCalled();
  });
  it('repairs the identity warning after verified reconnect with the actual token format', async () => {
    profile(profileVerificationCode('member', 'alice', key));
    const h = harness({ userId: 'member', username: 'alice', pickaxUserId: null, clientId: 'key', generation: 'original', status: 'identity_conflict' });
    const result = await h.service.connect('member', { clientId: 'key', clientSecret: 'secret', username: 'alice' });
    expect(result.status).toMatchObject({ connected: true, needsAttention: false, lastError: null });
    expect(h.upsert.mock.calls[0][0].update).toMatchObject({ status: 'active', pickaxUserId: null });
    expect(h.upsert.mock.calls[0][0].update.generation).toBeUndefined();
  });
  it('replaces delivery generation for a different key and rejects a different account', async () => {
    profile(profileVerificationCode('member', 'alice', key));
    const h = harness({ userId: 'member', username: 'alice', pickaxUserId: null, clientId: 'old-key', generation: 'old' });
    await h.service.connect('member', { clientId: 'new-key', clientSecret: 'secret', username: 'alice' });
    expect(h.upsert.mock.calls[0][0].update.generation).not.toBe('old');
    profile(profileVerificationCode('member', 'bob', key));
    await expect(h.service.connect('member', { clientId: 'new-key', clientSecret: 'secret', username: 'bob' })).rejects.toThrow('Disconnect');
  });
  it('scopes stale request failures and token invalidations to their original connection', async () => {
    const h = harness();
    await h.service.markError('member', 'Rejected', true, 'old');
    await h.service.invalidateAccessToken('member', 'old');
    await h.service.clearError('member', 'old');
    for (const [args] of h.updateMany.mock.calls) expect(args.where).toMatchObject({ userId: 'member', generation: 'old' });
  });
});
