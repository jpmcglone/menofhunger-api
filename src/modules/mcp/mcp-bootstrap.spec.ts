import type { SessionResult } from '../auth/auth.service';
import { mcpAccountFor } from './mcp-bootstrap';

const session = (user: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    user: { id: 'u1', username: 'brother', accountKind: 'person', premium: false, premiumPlus: false, siteAdmin: false, bannedAt: null, ...user },
    impersonatedByUserId: null,
    operatedByUserId: null,
    ...extra,
  }) as unknown as SessionResult;

describe('mcpAccountFor', () => {
  it('gives administrators the founder catalog', () => {
    expect(mcpAccountFor(session({ siteAdmin: true }))).toEqual({ id: 'u1', username: 'brother', audience: 'admin' });
  });

  it('gives Premium and Premium+ people the read-only member catalog', () => {
    expect(mcpAccountFor(session({ premium: true }))?.audience).toBe('member');
    expect(mcpAccountFor(session({ premiumPlus: true }))?.audience).toBe('member');
  });

  it('refuses free, banned, non-person, impersonated, and page-operated sessions', () => {
    expect(mcpAccountFor(null)).toBeNull();
    expect(mcpAccountFor(session({}))).toBeNull();
    expect(mcpAccountFor(session({ premium: true, bannedAt: new Date() }))).toBeNull();
    expect(mcpAccountFor(session({ premium: true, accountKind: 'page' }))).toBeNull();
    expect(mcpAccountFor(session({ premium: true }, { impersonatedByUserId: 'admin' }))).toBeNull();
    expect(mcpAccountFor(session({ premium: true }, { operatedByUserId: 'owner' }))).toBeNull();
  });

  it('does not grant the founder catalog to an impersonated administrator', () => {
    expect(mcpAccountFor(session({ siteAdmin: true, premium: true }, { impersonatedByUserId: 'other' }))).toBeNull();
  });
});
