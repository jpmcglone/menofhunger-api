import { PickaxConnectionService } from './pickax-connection.service';
import { sealSecret } from '../../common/crypto/secret-box';
import { PickaxApiError } from './pickax-api.client';
import { profileVerificationCode } from './pickax-identity';

const key = 'test-only-key';
const token = `header.${Buffer.from(JSON.stringify({ type: 'access', credentialId: 'credential', tokenVersion: 1, iat: 1, exp: 2, aud: 'third-party', iss: 'pickax' })).toString('base64url')}.signature`;

describe('Pickax credentials reconnect', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  function harness(current: any = null) {
    const upsert = jest.fn(async ({ create, update }) => ({ ...current, ...(current ? update : create) }));
    const updateMany = jest.fn(async ({ data }: any) => { if (current) Object.assign(current, data); return { count: current ? 1 : 0 }; });
    const exchangeCredentials = jest.fn(async () => ({ accessToken: token, refreshToken: 'refresh', expiresInSeconds: 3600, responseKeys: ['accessToken'] }));
    const prisma: any = {
      pickaxConnection: { findUnique: jest.fn(async () => current), findFirst: jest.fn(async () => null), upsert, updateMany },
      user: { update: jest.fn(async () => ({})), findUnique: jest.fn(async () => null) },
      $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    };
    const service = new PickaxConnectionService(prisma, { pickaxSecretEncryptionKey: () => key } as any,
      { exchangeCredentials } as any,
      {} as any, { emitPublicProfileUpdated: jest.fn() } as any, { emitMeUpdated: jest.fn() } as any,
      { available: () => false } as any, {} as any);
    return { service, upsert, updateMany, prisma, exchangeCredentials };
  }
  function profile(text: string) { global.fetch = jest.fn(async () => new Response(text)) as any; }
  function saved() { return { userId: 'member', username: 'alice', authKind: 'credentials', pickaxUserId: null, clientId: 'saved-id', clientSecretEnc: sealSecret('saved-secret', key), generation: 'original', status: 'identity_conflict' }; }
  it('reuses saved credentials without repeating profile proof or returning secrets', async () => {
    global.fetch = jest.fn() as any;
    const h = harness(saved());
    const result = await h.service.reconnect('member', 'operator');
    expect(h.exchangeCredentials).toHaveBeenCalledWith('saved-id', 'saved-secret');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ connected: true, needsAttention: false, lastError: null });
    expect(JSON.stringify(result)).not.toMatch(/saved-secret|saved-id|accessToken|clientSecret/);
    expect(h.updateMany.mock.calls[0][0]).toMatchObject({ where: { userId: 'member', generation: 'original' }, data: { authorizedByUserId: 'operator' } });
    expect(h.upsert).not.toHaveBeenCalled();
  });
  it('keeps the connection when Pickax rejects the saved key', async () => {
    const h = harness(saved());
    h.exchangeCredentials.mockRejectedValue(new PickaxApiError(401, 'invalid', 'Rejected'));
    await expect(h.service.reconnect('member')).rejects.toThrow('Disconnect, then connect with a new key');
    expect(h.updateMany).not.toHaveBeenCalled();
  });
  it('does not recreate a connection disconnected during the token exchange', async () => {
    const h = harness(saved());
    h.updateMany.mockResolvedValue({ count: 0 });
    await expect(h.service.reconnect('member')).rejects.toThrow('connection changed');
    expect(h.upsert).not.toHaveBeenCalled();
  });
  it('requires an existing saved connection', async () => {
    const h = harness();
    await expect(h.service.reconnect('member')).rejects.toThrow('Connect Pickax before reconnecting');
    expect(h.exchangeCredentials).not.toHaveBeenCalled();
  });
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
