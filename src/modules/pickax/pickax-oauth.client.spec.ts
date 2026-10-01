import { PickaxOAuthClient, pickaxOAuthIdentity, pickaxOAuthTokens } from './pickax-oauth.client';
describe('proposed Pickax OAuth fixtures', () => {
  it('requires authoritative immutable identity and a confirmed handle', () => {
    expect(pickaxOAuthIdentity.parse({ data: { id: 'immutable-1', username: 'member' } }).data.id).toBe('immutable-1');
    expect(pickaxOAuthIdentity.safeParse({ data: { username: 'member' } }).success).toBe(false);
    expect(pickaxOAuthIdentity.safeParse({ data: { id: 'immutable-1', username: '<script>' } }).success).toBe(false);
  });
  it('requires a refreshable standard bearer response', () => {
    expect(pickaxOAuthTokens.safeParse({ access_token: 'synthetic', refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 900 }).success).toBe(true);
    expect(pickaxOAuthTokens.safeParse({ access_token: 'synthetic' }).success).toBe(false);
  });
  it('is unavailable until explicitly configured and enabled', () => {
    const client = new PickaxOAuthClient({ partner: () => ({ pickaxOAuth: false }) } as any);
    expect(client.available()).toBe(false); expect(() => client.config()).toThrow();
  });
});
