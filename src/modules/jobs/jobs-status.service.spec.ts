import { JobsStatusService } from './jobs-status.service';

// QueueEvents opens a Redis connection in the constructor, so the service is built without
// running it. `getQueuesHealth` only touches the injected Queue objects.
function makeService(queues: Record<string, unknown>[]) {
  const svc = Object.create(JobsStatusService.prototype) as JobsStatusService;
  Object.assign(svc, {
    backgroundQueue: queues[0],
    marvinQueue: queues[1],
    sideEffectsQueue: queues[2],
  });
  return svc;
}

function fakeQueue(name: string, counts: Partial<Record<string, number>> = {}, workers = 1) {
  return {
    name,
    getWorkers: jest.fn(async () => Array.from({ length: workers }, (_, i) => ({ id: `w${i}` }))),
    getWaitingCount: jest.fn(async () => counts.waiting ?? 0),
    getActiveCount: jest.fn(async () => counts.active ?? 0),
    getDelayedCount: jest.fn(async () => counts.delayed ?? 0),
    getFailedCount: jest.fn(async () => counts.failed ?? 0),
    isPaused: jest.fn(async () => false),
  };
}

describe('JobsStatusService.getQueuesHealth', () => {
  it('reports worker count and depth for every queue', async () => {
    const svc = makeService([
      fakeQueue('moh_background', { waiting: 2, failed: 1 }, 1),
      fakeQueue('moh_marvin', {}, 2),
      fakeQueue('moh_side_effects', { waiting: 40, active: 8 }, 3),
    ]);

    const health = await svc.getQueuesHealth();

    expect(health.allQueuesHaveWorkers).toBe(true);
    expect(health.queues.map((q) => q.name)).toEqual(['moh_background', 'moh_marvin', 'moh_side_effects']);
    expect(health.queues[0]).toMatchObject({ workers: 1, waiting: 2, failed: 1, error: null });
    expect(health.queues[2]).toMatchObject({ workers: 3, waiting: 40, active: 8 });
  });

  it('flags the whole readout when a queue has no worker draining it', async () => {
    const svc = makeService([
      fakeQueue('moh_background', {}, 1),
      fakeQueue('moh_marvin', {}, 1),
      fakeQueue('moh_side_effects', { waiting: 900 }, 0),
    ]);

    const health = await svc.getQueuesHealth();

    expect(health.allQueuesHaveWorkers).toBe(false);
    expect(health.queues[2]).toMatchObject({ workers: 0, waiting: 900 });
  });

  it('degrades to a zeroed row with an error message when Redis is unreachable', async () => {
    const broken = fakeQueue('moh_side_effects');
    broken.getWorkers = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const svc = makeService([fakeQueue('moh_background'), fakeQueue('moh_marvin'), broken]);

    const health = await svc.getQueuesHealth();

    expect(health.queues[2]).toMatchObject({ name: 'moh_side_effects', workers: 0, error: 'ECONNREFUSED' });
    expect(health.allQueuesHaveWorkers).toBe(false);
  });
});
