import { PickaxApiClient } from '../pickax/pickax-api.client';
import { XApiClient } from '../x/x-api.client';

describe.each(['pickax', 'x'] as const)('%s remote removal confirmation', platform => {
  afterEach(() => jest.restoreAllMocks());
  const remove = () => platform === 'pickax'
    ? new PickaxApiClient().deleteContent('synthetic-token', 'posts', 'synthetic-id')
    : new XApiClient().deletePost('synthetic-token', 'synthetic-id');
  it.each([204, 200, 404])('accepts a confirmed removal or already-absent copy (%s)', async status => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(status === 204 ? null : JSON.stringify({ data: { deleted: true } }), { status }));
    await expect(remove()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'DELETE', redirect: 'error' });
  });
  it.each([{ status: 200, data: { deleted: false } }, { status: 200, data: {} }, { status: 502, data: {} }])('does not claim an unconfirmed response succeeded ($status / $data)', async ({ status, data }) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data }), { status }));
    await expect(remove()).rejects.toMatchObject({ status: 502 });
  });
});
