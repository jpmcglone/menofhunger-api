import { fetchYoutubeMetadata, needsYoutubeEnrichment, youtubeVideoId } from './youtube-link-metadata';

const id = 'yVm8vDoMzYs';
describe('YouTube metadata', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    `https://www.youtube.com/watch?v=${id}&t=10`, `https://youtu.be/${id}?si=tracking`,
    `https://m.youtube.com/shorts/${id}`, `https://youtube.com/live/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`, `https://music.youtube.com/watch?v=${id}`,
  ])('recognizes %s', (url) => expect(youtubeVideoId(url)).toBe(id));

  it.each(['https://youtube.com.evil.test/watch?v=yVm8vDoMzYs', 'https://example.com/watch?v=yVm8vDoMzYs',
    'file://youtube.com/watch?v=yVm8vDoMzYs', 'https://youtube.com/playlist?list=abc', 'https://youtu.be/invalid'])
  ('rejects %s', (url) => expect(youtubeVideoId(url)).toBeNull());

  it('gets the actual title and channel without returning playable provider HTML', async () => {
    const request = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      type: 'video', title: ' Actual video title ', author_name: ' The channel ', html: '<iframe autoplay />',
      thumbnail_url: 'https://untrusted.example/pixel',
    })));
    const signal = new AbortController().signal;
    const result = await fetchYoutubeMetadata(`https://youtu.be/${id}?si=tracking`, signal);
    expect(result).toEqual({ title: 'Actual video title', siteName: 'YouTube · The channel', description: null,
      imageUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` });
    const endpoint = request.mock.calls[0]![0] as URL;
    expect(endpoint.origin + endpoint.pathname).toBe('https://www.youtube.com/oembed');
    expect(endpoint.searchParams.get('url')).toBe(`https://www.youtube.com/watch?v=${id}`);
    expect(request.mock.calls[0]![1]).toEqual({ signal, redirect: 'error' });
  });

  it.each([{ type: 'video', title: 'YouTube' }, { type: 'photo', title: 'Title', author_name: 'Channel' }, null])
  ('does not cache incomplete provider results: %j', async (payload) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload)));
    expect(await fetchYoutubeMetadata(`https://youtu.be/${id}`, new AbortController().signal)).toBeNull();
  });

  it('handles unavailable/private videos without inventing a title', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    expect(await fetchYoutubeMetadata(`https://youtu.be/${id}`, new AbortController().signal)).toBeNull();
  });

  it('refreshes legacy generic records but reuses enriched records', () => {
    expect(needsYoutubeEnrichment(null)).toBe(true);
    expect(needsYoutubeEnrichment({ title: 'YouTube video', siteName: 'YouTube' })).toBe(true);
    expect(needsYoutubeEnrichment({ title: 'Actual title', siteName: 'YouTube · Channel' })).toBe(false);
  });
});
