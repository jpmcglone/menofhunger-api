import { XApiClient } from './x-api.client';

describe('X final send boundary', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(['https://example.com', 'Look at example.com/path', 'HTTPS://EXAMPLE.COM', 'www.example.com', '例子.中国', 'münchen.de'])('never sends a URL: %s', async text => {
    const fetch = jest.spyOn(global, 'fetch');
    await expect(new XApiClient().createPost('test-token', { text })).rejects.toMatchObject({ code: 'links_unsupported' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('still sends plain text and photo IDs', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { id: '123' } }), { status: 201 }));
    await expect(new XApiClient().createPost('test-token', { text: 'Just words', mediaIds: ['photo'] })).resolves.toBe('123');
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ text: 'Just words', media: { media_ids: ['photo'] } });
  });
});
