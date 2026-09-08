import { PresenceRedisStateService } from './presence-redis-state.service';

describe('required daily cache invalidation broadcast', () => {
  it('propagates Redis failure for required publication invalidations', async () => {
    const publish = jest.fn().mockRejectedValue(new Error('Redis unavailable'));
    const redis = { duplicate: jest.fn().mockReturnValue({}), raw: () => ({ publish }) };
    const service = new PresenceRedisStateService(redis as never, {} as never, {} as never);
    await expect(service.publishBroadcast({
      event: 'daily:content-published', payload: { item: 'word', dayKey: '2026-09-08' }, required: true,
    })).rejects.toThrow('Redis unavailable');
    // Existing unrelated broadcasts keep their best-effort behavior.
    await expect(service.publishBroadcast({ event: 'wotd:like-updated', payload: {} })).resolves.toBeUndefined();
  });
});
