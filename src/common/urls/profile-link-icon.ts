import type { ProfileLinkIcon } from '../dto/profile-links.dto';

/** [icon, registrable domains]; a host matches a domain or any subdomain of it. */
const ICON_DOMAINS: ReadonlyArray<readonly [ProfileLinkIcon, readonly string[]]> = [
  ['x', ['x.com', 'twitter.com']],
  ['pickax', ['pickax.com']],
  ['youtube', ['youtube.com', 'youtu.be']],
  ['rumble', ['rumble.com']],
  ['linkedin', ['linkedin.com']],
  ['substack', ['substack.com']],
  ['ghost', ['ghost.io']],
  ['github', ['github.com']],
  ['soundcloud', ['soundcloud.com']],
  ['bandcamp', ['bandcamp.com']],
  ['etsy', ['etsy.com']],
  ['gumroad', ['gumroad.com']],
  ['sketchfab', ['sketchfab.com']],
  ['tiktok', ['tiktok.com']],
  ['locals', ['locals.com']],
  ['facebook', ['facebook.com', 'fb.com']],
  ['instagram', ['instagram.com']],
  ['spotify', ['spotify.com']],
];

export function profileLinkIconForHost(host: string): ProfileLinkIcon {
  const h = (host ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) return 'website';
  for (const [icon, domains] of ICON_DOMAINS) {
    for (const d of domains) {
      if (h === d || h.endsWith(`.${d}`)) return icon;
    }
  }
  return 'website';
}
