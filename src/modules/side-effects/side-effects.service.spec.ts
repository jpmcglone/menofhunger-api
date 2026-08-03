import { SideEffectsRegistry } from './side-effects.registry';
import { SideEffectsService } from './side-effects.service';

function flush(): Promise<void> {
  // Two hops: one for the enqueue promise chain, one for the setImmediate fallback.
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

describe('SideEffectsService.dispatch', () => {
  function makeService(queueAdd: jest.Mock) {
    const queue = { add: queueAdd } as any;
    const registry = new SideEffectsRegistry();
    const service = new SideEffectsService(queue, registry);
    return { service, registry, queue };
  }

  it('enqueues the effect with retry options and returns synchronously', () => {
    const add = jest.fn().mockResolvedValue({ id: '1' });
    const { service } = makeService(add);

    const result = service.dispatch('user.verified', { userId: 'u1' });

    expect(result).toBeUndefined();
    expect(add).toHaveBeenCalledWith(
      'user.verified',
      { userId: 'u1' },
      expect.objectContaining({ attempts: 3, removeOnComplete: true }),
    );
  });

  it('passes a jobId through for dedupe', () => {
    const add = jest.fn().mockResolvedValue({ id: '1' });
    const { service } = makeService(add);

    service.dispatch('post.deleted', { postId: 'p1' }, { jobId: 'post-deleted-p1' });

    expect(add).toHaveBeenCalledWith(
      'post.deleted',
      { postId: 'p1' },
      expect.objectContaining({ jobId: 'post-deleted-p1' }),
    );
  });

  // A write must never fail because Redis is unhappy — that's the whole point of the seam.
  it('never throws when the enqueue rejects', async () => {
    const add = jest.fn().mockRejectedValue(new Error('redis down'));
    const { service } = makeService(add);

    expect(() => service.dispatch('user.verified', { userId: 'u1' })).not.toThrow();
    await flush();
  });

  it('falls back to running the handler in-process when the enqueue fails', async () => {
    const add = jest.fn().mockRejectedValue(new Error('redis down'));
    const { service, registry } = makeService(add);
    const handler = jest.fn().mockResolvedValue(undefined);
    registry.register('user.verified', handler);

    service.dispatch('user.verified', { userId: 'u1' });
    await flush();

    expect(handler).toHaveBeenCalledWith({ userId: 'u1' });
  });

  it('does not fall back when the enqueue failed only because the jobId was a duplicate', async () => {
    const add = jest.fn().mockRejectedValue(new Error('Job with id post-deleted-p1 already exists'));
    const { service, registry } = makeService(add);
    const handler = jest.fn().mockResolvedValue(undefined);
    registry.register('post.deleted', handler);

    service.dispatch('post.deleted', { postId: 'p1' }, { jobId: 'post-deleted-p1' });
    await flush();

    expect(handler).not.toHaveBeenCalled();
  });

  it('swallows a failure inside the in-process fallback', async () => {
    const add = jest.fn().mockRejectedValue(new Error('redis down'));
    const { service, registry } = makeService(add);
    registry.register('user.verified', jest.fn().mockRejectedValue(new Error('handler blew up')));

    service.dispatch('user.verified', { userId: 'u1' });

    await expect(flush()).resolves.toBeUndefined();
  });
});

describe('SideEffectsRegistry', () => {
  it('returns null for an unregistered effect', () => {
    expect(new SideEffectsRegistry().get('post.created')).toBeNull();
  });

  it('keeps the first handler when the same effect is registered twice', () => {
    const registry = new SideEffectsRegistry();
    const first = jest.fn().mockResolvedValue(undefined);
    const second = jest.fn().mockResolvedValue(undefined);

    registry.register('post.deleted', first);
    registry.register('post.deleted', second);

    expect(registry.get('post.deleted')).toBe(first);
  });

  it('lists registered names sorted', () => {
    const registry = new SideEffectsRegistry();
    registry.register('user.verified', jest.fn());
    registry.register('post.created', jest.fn());

    expect(registry.names()).toEqual(['post.created', 'user.verified']);
  });
});
