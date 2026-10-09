import {
  normalizeProfileLinkUrl,
  profileLinkDedupeKey,
  profileLinkDisplay,
  profileLinkHost,
} from './profile-link-url';

describe('normalizeProfileLinkUrl', () => {
  it('prepends https:// to bare domains and upgrades http', () => {
    expect(normalizeProfileLinkUrl('example.com')).toBe('https://example.com/');
    expect(normalizeProfileLinkUrl('http://example.com/a')).toBe('https://example.com/a');
    expect(normalizeProfileLinkUrl('  https://www.example.com/x  ')).toBe('https://www.example.com/x');
  });

  it('strips fragments and keeps harmless queries', () => {
    expect(normalizeProfileLinkUrl('https://example.com/a?ref=1#top')).toBe('https://example.com/a?ref=1');
  });

  it.each([
    '',
    '   ',
    'javascript:alert(1)',
    'data:text/html,hi',
    'ftp://example.com',
    'https://user:pw@example.com',
    'https://example.com:8080',
    'https://127.0.0.1',
    'https://localhost',
    'https://printer.local',
    'https://example.com/?api_key=1',
    'https://example.com/?Token=1',
    'https://example.com/?x=1&session_id=2',
    'https://example.com/?auth=1',
    'https://example.com/?password=1',
    'https://bit.ly/abc',
    'https://sub.bit.ly/abc',
    'https://t.co/abc',
    'tinyurl.com/abc',
    'https://www.iplogger.org/x',
    'https://yip.su/x',
    'https://2no.co/x',
  ])('rejects %p', (input) => {
    expect(normalizeProfileLinkUrl(input)).toBeNull();
  });

  it('does not block lookalike hosts', () => {
    expect(normalizeProfileLinkUrl('https://orbit.ly.example.com')).not.toBeNull();
    expect(normalizeProfileLinkUrl('https://not-t.co')).not.toBeNull();
  });
});

describe('profile link helpers', () => {
  it('derives host without www and icon', () => {
    expect(profileLinkHost('https://www.Example.com/a')).toBe('example.com');
    expect(profileLinkDisplay('https://www.youtube.com/@x')).toEqual({ host: 'youtube.com', icon: 'youtube' });
    expect(profileLinkDisplay('https://example.com')).toEqual({ host: 'example.com', icon: 'website' });
  });

  it('dedupes on host + path ignoring www, case, and trailing slash', () => {
    expect(profileLinkDedupeKey('https://www.Example.com/a/')).toBe(profileLinkDedupeKey('https://example.com/a'));
    expect(profileLinkDedupeKey('https://example.com/a')).not.toBe(profileLinkDedupeKey('https://example.com/b'));
  });
});
