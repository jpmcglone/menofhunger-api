import { FitnessHealthDataService } from './fitness-health-data.service';

describe('fitness share publication', () => {
  it('keeps the fitness snapshot/response while sending post creation through the owned lifecycle', async () => {
    const snapshot = { type: 'activity', data: { distanceM: 1000 } };
    const prisma = {
      fitnessActivity: { findFirst: jest.fn(async () => ({ id: 'activity', activityType: 'run', startedAt: new Date(), durationSec: 600, distanceM: 1000 })) },
      fitnessShare: { create: jest.fn(async () => ({ id: 'fitness' })) },
    };
    const post = { id: 'share', userId: 'author', body: '', visibility: 'public', kind: 'fitnessShare', createdAt: new Date(), user: { id: 'author', username: 'author', orgMemberships: [] }, mentions: [], media: [], fitnessShare: { id: 'fitness', shareType: 'activity', snapshot } };
    const writes = { createFitnessShare: jest.fn(async () => post) };
    const service = new FitnessHealthDataService(prisma as never, {} as never, writes as never);
    const result = await service.createSharePost({ userId: 'author', shareType: 'activity', activityId: 'activity', body: 'commentary', visibility: 'public', r2BaseUrl: null });
    expect(writes.createFitnessShare).toHaveBeenCalledWith({ userId: 'author', fitnessShareId: 'fitness', body: 'commentary', visibility: 'public' });
    expect(result.post).toMatchObject({ id: 'share', fitnessShare: { id: 'fitness', shareType: 'activity', snapshot } });
    expect(result.fitnessShare).toMatchObject({ id: 'fitness', shareType: 'activity' });
  });

  it('rejects abusive commentary before reading or storing a snapshot or creating a post', async () => {
    const prisma = {
      fitnessActivity: { findFirst: jest.fn() },
      fitnessShare: { create: jest.fn() },
    };
    const writes = { createFitnessShare: jest.fn() };
    const service = new FitnessHealthDataService(prisma as never, {} as never, writes as never);
    await expect(service.createSharePost({
      userId: 'author', shareType: 'activity', activityId: 'activity',
      body: 'I will kill you', visibility: 'public', r2BaseUrl: null,
    })).rejects.toThrow();
    expect(prisma.fitnessActivity.findFirst).not.toHaveBeenCalled();
    expect(prisma.fitnessShare.create).not.toHaveBeenCalled();
    expect(writes.createFitnessShare).not.toHaveBeenCalled();
  });

});
