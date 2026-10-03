import { SfuProviderError, SfuProviderService } from './sfu-provider.service';

describe('SFU provider cleanup confirmation', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  let service: SfuProviderService;
  const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    service = new SfuProviderService({ cloudflareSfu: () => ({ appId: 'test-app', secret: 'test-secret' }) } as never);
  });
  afterEach(() => { global.fetch = originalFetch; });

  it('reports HTTP status without exposing provider response bodies', async () => {
    fetchMock.mockResolvedValueOnce(response({ error: 'secret SDP and credentials' }, 401));
    await expect(service.request('POST', '/sessions/new')).rejects.toEqual(new SfuProviderError('http', 401));
  });

  it('sanitizes network failures before they reach call logs', async () => {
    fetchMock.mockRejectedValueOnce(new Error('secret request metadata'));
    await expect(service.request('POST', '/sessions/new')).rejects.toEqual(new SfuProviderError('network'));
  });

  it('keeps failed closure retryable while a provider track remains active', async () => {
    fetchMock.mockResolvedValueOnce(response({ tracks: [{ mid: '0', errorCode: 'close_track_error' }] }));
    fetchMock.mockResolvedValueOnce(response({ tracks: [{ mid: '0', status: 'active' }] }));
    await expect(service.close('session', ['0'])).rejects.toThrow('SFU cleanup incomplete');
  });

  it('accepts an already closed track only after checking provider state', async () => {
    fetchMock.mockResolvedValueOnce(response({ tracks: [{ mid: '0', errorCode: 'close_track_error' }] }));
    fetchMock.mockResolvedValueOnce(response({ tracks: [{ mid: '0', status: 'inactive' }] }));
    await expect(service.close('session', ['0'])).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('closes all active tracks and treats an expired session as cleaned up', async () => {
    fetchMock.mockResolvedValueOnce(response({ tracks: [{ mid: '0', status: 'active' }, { mid: '1', status: 'inactive' }] }));
    fetchMock.mockResolvedValueOnce(response({ tracks: [{ mid: '0' }] }));
    await service.closeAll('session');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ force: true, tracks: [{ mid: '0' }] });
    fetchMock.mockResolvedValueOnce(response({}, 404));
    await expect(service.closeAll('expired-session')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not mistake provider outages for completed cleanup', async () => {
    fetchMock.mockResolvedValueOnce(response({}, 503));
    await expect(service.closeAll('session')).rejects.toThrow('SFU request failed');
  });
});
