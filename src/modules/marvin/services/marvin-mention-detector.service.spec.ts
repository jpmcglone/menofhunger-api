import { MarvinMentionDetectorService } from './marvin-mention-detector.service';

function makeIdentity(opts: { username?: string; cachedUserId?: string | null } = {}) {
  const username = opts.username ?? 'marv';
  const cachedUserId = opts.cachedUserId ?? null;
  return {
    marvUsernameLower: () => username.toLowerCase(),
    cachedMarvUserId: () => cachedUserId,
  } as any;
}

describe('MarvinMentionDetectorService.bodyMentionsMarv', () => {
  it('returns false for empty / null bodies', () => {
    const svc = new MarvinMentionDetectorService(makeIdentity());
    expect(svc.bodyMentionsMarv('')).toBe(false);
    expect(svc.bodyMentionsMarv(null)).toBe(false);
    expect(svc.bodyMentionsMarv(undefined)).toBe(false);
  });

  it('matches @marv case-insensitively', () => {
    const svc = new MarvinMentionDetectorService(makeIdentity());
    expect(svc.bodyMentionsMarv('hey @marv help me')).toBe(true);
    expect(svc.bodyMentionsMarv('@MARV is this true?')).toBe(true);
    expect(svc.bodyMentionsMarv('@Marv 👋')).toBe(true);
  });

  it('does not match other usernames', () => {
    const svc = new MarvinMentionDetectorService(makeIdentity());
    expect(svc.bodyMentionsMarv('hey @marvin help me')).toBe(false);
    expect(svc.bodyMentionsMarv('hey @markdown')).toBe(false);
  });

  it('respects custom MARV_USERNAME', () => {
    const svc = new MarvinMentionDetectorService(makeIdentity({ username: 'sage' }));
    expect(svc.bodyMentionsMarv('hey @sage help me')).toBe(true);
    expect(svc.bodyMentionsMarv('hey @marv help me')).toBe(false);
  });

  it('does not treat email-like prefixes as mentions', () => {
    const svc = new MarvinMentionDetectorService(makeIdentity());
    // "foo@marv.com" is an email — should NOT count as @marv.
    expect(svc.bodyMentionsMarv('contact me at foo@marv.com today')).toBe(false);
  });
});

describe('MarvinMentionDetectorService.resolvedIdsIncludeMarv', () => {
  it('returns false when marv id is not cached', () => {
    const svc = new MarvinMentionDetectorService(makeIdentity({ cachedUserId: null }));
    expect(svc.resolvedIdsIncludeMarv(['u1', 'u2'])).toBe(false);
  });

  it('returns true when marv id is in the resolved set', () => {
    const svc = new MarvinMentionDetectorService(makeIdentity({ cachedUserId: 'marv-id' }));
    expect(svc.resolvedIdsIncludeMarv(['u1', 'marv-id', 'u3'])).toBe(true);
  });

  it('returns false when marv id is not in the resolved set', () => {
    const svc = new MarvinMentionDetectorService(makeIdentity({ cachedUserId: 'marv-id' }));
    expect(svc.resolvedIdsIncludeMarv(['u1', 'u2'])).toBe(false);
  });
});
