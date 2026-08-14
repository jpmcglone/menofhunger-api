import { fetchYouTubeOEmbedTitle, youtubeOEmbedRequestUrl } from './youtube-oembed-title';

describe('youtubeOEmbedRequestUrl', () => {
  it('builds the watch oEmbed URL from common YouTube shapes', () => {
    expect(youtubeOEmbedRequestUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=json',
    );
    expect(youtubeOEmbedRequestUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toContain(
      'v=dQw4w9WgXcQ',
    );
    expect(youtubeOEmbedRequestUrl('https://example.com/watch')).toBeNull();
  });
});

describe('fetchYouTubeOEmbedTitle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the title when oEmbed succeeds', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ title: 'THE GREAT DEBATE' }),
    } as Response);
    await expect(fetchYouTubeOEmbedTitle('https://youtu.be/dQw4w9WgXcQ')).resolves.toBe(
      'THE GREAT DEBATE',
    );
  });

  it('returns null when oEmbed fails', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as Response);
    await expect(fetchYouTubeOEmbedTitle('https://youtu.be/dQw4w9WgXcQ')).resolves.toBeNull();
  });
});
