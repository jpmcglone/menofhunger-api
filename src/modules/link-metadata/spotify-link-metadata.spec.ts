import {
  spotifyContent,
  isSpotifyShareUrl,
  resolveSpotifyShareUrl,
  fetchSpotifyMetadata,
} from './spotify-link-metadata';
const id = '4cOdK2wGLETKBW3PvgPWqT';
const canonical = `https://open.spotify.com/track/${id}`;
describe('Spotify link metadata', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(['track', 'album', 'artist', 'playlist', 'episode', 'show'])(
    'normalizes %s links',
    (kind) => {
      expect(
        spotifyContent(`https://open.spotify.com/intl-de/${kind}/${id}?si=abc`)
          ?.url,
      ).toBe(`https://open.spotify.com/${kind}/${id}`);
    },
  );
  it('rejects unrelated hosts and unsupported paths', () => {
    expect(
      spotifyContent(`https://open.spotify.com.evil.test/track/${id}`),
    ).toBeNull();
    expect(
      spotifyContent(`https://open.spotify.com/track/${id}/extra`),
    ).toBeNull();
    expect(isSpotifyShareUrl('https://spotify.link')).toBe(false);
  });
  it('resolves Spotify redirects without fetching the final player', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: canonical + '?si=abc' },
      }),
    );
    expect(
      await resolveSpotifyShareUrl(
        'https://spotify.link/example',
        AbortSignal.timeout(1000),
      ),
    ).toBe(canonical);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual');
  });
  it.each([
    'http://127.0.0.1/private',
    'https://evil.test/track/anything',
    'https://spotify.link.evil.test/x',
  ])('never follows an untrusted redirect to %s', async (location) => {
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location } }),
      );
    expect(
      await resolveSpotifyShareUrl(
        'https://spoti.fi/example',
        AbortSignal.timeout(1000),
      ),
    ).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds redirect loops', async () => {
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async () =>
          new Response(null, { status: 302, headers: { location: '/loop' } }),
      );
    expect(
      await resolveSpotifyShareUrl(
        'https://spotify.link/loop',
        AbortSignal.timeout(1000),
      ),
    ).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('uses official oEmbed metadata while ignoring provider HTML', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(
      Response.json({
        title: ' A song ',
        thumbnail_url: 'https://i.scdn.co/image/abc',
        html: '<script>untrusted</script>',
      }),
    );
    expect(
      await fetchSpotifyMetadata(canonical, AbortSignal.timeout(1000)),
    ).toEqual({
      title: 'A song',
      imageUrl: 'https://i.scdn.co/image/abc',
      description: null,
      siteName: 'Spotify',
    });
    expect(String(fetcher.mock.calls[0][0])).toContain(
      'https://open.spotify.com/oembed?url=',
    );
  });
  it('keeps metadata usable when artwork is untrusted', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      Response.json({
        title: 'A song',
        thumbnail_url: 'https://evil.test/image.png',
      }),
    );
    expect(
      (await fetchSpotifyMetadata(canonical, AbortSignal.timeout(1000)))
        ?.imageUrl,
    ).toBeNull();
  });
  it("accepts Spotify's current artwork CDN", async () => {
    const thumbnail = 'https://image-cdn-ak.spotifycdn.com/image/abc';
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        Response.json({ title: 'A song', thumbnail_url: thumbnail }),
      );
    expect(
      (await fetchSpotifyMetadata(canonical, AbortSignal.timeout(1000)))
        ?.imageUrl,
    ).toBe(thumbnail);
  });
  it('returns no metadata for removed content', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 404 }));
    expect(
      await fetchSpotifyMetadata(canonical, AbortSignal.timeout(1000)),
    ).toBeNull();
  });
});
