import { publicPreviewUrl } from './public-preview-url';
import { profileLinkIconForHost } from './profile-link-icon';
import type { ProfileLinkIcon } from '../dto/profile-links.dto';

/** URL shorteners and IP-grabber hosts (and their subdomains) that cannot be profile links. */
export const PROFILE_LINK_BLOCKED_HOSTS: readonly string[] = [
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'cutt.ly',
  'rebrand.ly',
  'shorturl.at',
  'grabify.link',
  'iplogger.org',
  'iplogger.com',
  '2no.co',
  'yip.su',
];

const SECRET_QUERY_KEY = /key|token|secret|pass|session|auth/i;

export function isBlockedProfileLinkHost(host: string): boolean {
  const h = (host ?? '').trim().toLowerCase();
  return PROFILE_LINK_BLOCKED_HOSTS.some((blocked) => h === blocked || h.endsWith(`.${blocked}`));
}

/**
 * Canonical, safe https URL for a profile link, or null when the input is unusable.
 * Bare domains get https://; http:// is upgraded; fragments are stripped; credentials,
 * ports, IPs, local TLDs, secret-looking query keys, and shorteners are rejected.
 */
export function normalizeProfileLinkUrl(raw: string): string | null {
  const input = (raw ?? '').trim();
  if (!input) return null;
  let candidate: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    candidate = input.replace(/^http:\/\//i, 'https://');
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^[^/?#]*\.[^/?#]*:\d+(?:[/?#]|$)/.test(input)) {
    // javascript:, data:, mailto:, etc. — only host:port-looking input falls through (and is rejected below).
    return null;
  } else {
    candidate = `https://${input.replace(/^\/\//, '')}`;
  }
  const safe = publicPreviewUrl(candidate);
  if (!safe) return null;
  let url: URL;
  try {
    url = new URL(safe);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  url.hash = '';
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_KEY.test(key)) return null;
  }
  if (isBlockedProfileLinkHost(url.hostname)) return null;
  return url.toString();
}

/** Hostname without a leading `www.`. */
export function profileLinkHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Key used to detect duplicate links: host, path without trailing slash, and query. */
export function profileLinkDedupeKey(url: string): string {
  try {
    const u = new URL(url);
    return `${profileLinkHost(url)}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export function profileLinkDisplay(url: string): { host: string; icon: ProfileLinkIcon } {
  const host = profileLinkHost(url);
  return { host, icon: profileLinkIconForHost(host) };
}
