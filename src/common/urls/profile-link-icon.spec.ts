import { profileLinkIconForHost } from './profile-link-icon';

describe('profileLinkIconForHost', () => {
  it.each([
    ['x.com', 'x'],
    ['www.twitter.com', 'x'],
    ['pickax.com', 'pickax'],
    ['youtu.be', 'youtube'],
    ['m.youtube.com', 'youtube'],
    ['rumble.com', 'rumble'],
    ['www.linkedin.com', 'linkedin'],
    ['foo.substack.com', 'substack'],
    ['my.ghost.io', 'ghost'],
    ['github.com', 'github'],
    ['soundcloud.com', 'soundcloud'],
    ['artist.bandcamp.com', 'bandcamp'],
    ['etsy.com', 'etsy'],
    ['shop.gumroad.com', 'gumroad'],
    ['sketchfab.com', 'sketchfab'],
    ['tiktok.com', 'tiktok'],
    ['group.locals.com', 'locals'],
    ['fb.com', 'facebook'],
    ['instagram.com', 'instagram'],
    ['open.spotify.com', 'spotify'],
    ['example.com', 'website'],
    ['notx.com', 'website'],
    ['', 'website'],
  ])('%s -> %s', (host, icon) => {
    expect(profileLinkIconForHost(host)).toBe(icon);
  });
});
