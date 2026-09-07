import { checkinSchedule, isCheckinOpen } from './checkin-schedule';
import { CheckinsService } from './checkins.service';
import { PostsMutationService } from '../posts/posts-mutation.service';

describe('daily check-in window', () => {
  it.each([
    ['2026-09-07T20:59:59.999Z', false],
    ['2026-09-07T21:00:00.000Z', true],
    ['2026-09-08T03:59:59.999Z', true],
    ['2026-09-08T04:00:00.000Z', false],
    ['2026-01-07T21:59:59.999Z', false],
    ['2026-01-07T22:00:00.000Z', true],
    ['2026-03-08T21:00:00.000Z', true],
    ['2026-11-01T22:00:00.000Z', true],
  ])('%s is open: %s', (date, expected) => {
    expect(isCheckinOpen(new Date(date))).toBe(expected);
  });

  it.each([
    ['2026-03-08T06:00:00Z', '2026-03-08T21:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['2026-11-01T05:00:00Z', '2026-11-01T22:00:00.000Z', '2026-11-02T05:00:00.000Z'],
  ])('uses Eastern calendar boundaries across DST: %s', (date, opensAt, closesAt) => {
    expect(checkinSchedule(new Date(date))).toMatchObject({ opensAt, closesAt });
  });
});

function makeService() {
  const prisma = { user: { findUnique: jest.fn() } };
  const posts = { createPost: jest.fn() };
  const redis = { getJson: jest.fn().mockResolvedValue({
    dayKey: '2026-09-07', prompt: 'Cached prompt', hasCheckedInToday: false,
    coins: 0, checkinStreakDays: 2, allowedVisibilities: ['verifiedOnly'], crew: null, socialProof: null,
  }) };
  const service = new CheckinsService(prisma as never, posts as never, {} as never, {} as never,
    redis as never, {} as never, {} as never, {} as never);
  return { service, prisma, posts };
}

describe('check-in schedule enforcement', () => {
  it('hides the new prompt before 5pm, including on cache hits', async () => {
    const { service } = makeService();
    const state = await service.getTodayState({ userId: 'user', now: new Date('2026-09-07T20:59:59Z') });
    expect(state).toMatchObject({ isOpen: false, prompt: '', dayKey: '2026-09-07' });
  });

  it('reveals the current prompt at 5pm without waiting for the cache to expire', async () => {
    const { service } = makeService();
    const state = await service.getTodayState({ userId: 'user', now: new Date('2026-09-07T21:00:00Z') });
    expect(state.isOpen).toBe(true);
    expect(state.prompt).not.toBe('Cached prompt');
    expect(state.prompt.length).toBeGreaterThan(0);
    const next = await service.getTodayState({ userId: 'user', now: new Date('2026-09-08T21:00:00Z') });
    expect(next.prompt).not.toBe(state.prompt);
  });

  it('rejects closed submissions before accessing user data or creating posts', async () => {
    const { service, prisma, posts } = makeService();
    await expect(service.createTodayCheckin({ userId: 'user', body: 'Answer', visibility: 'verifiedOnly',
      now: new Date('2026-09-08T04:00:00Z') })).rejects.toThrow('Check-ins open at 5pm ET');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(posts.createPost).not.toHaveBeenCalled();
  });

  it('rejects a stale prompt instead of attaching an answer to a new question', async () => {
    const { service, posts } = makeService();
    await expect(service.createTodayCheckin({ userId: 'user', body: 'Answer', visibility: 'verifiedOnly',
      clientPrompt: 'Yesterday’s question', now: new Date('2026-09-07T21:00:00Z') })).rejects.toThrow('prompt has changed');
    expect(posts.createPost).not.toHaveBeenCalled();
  });

  it('also enforces the window at the underlying post mutation boundary', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-08T04:00:00Z'));
    try {
      const posts = Object.create(PostsMutationService.prototype) as PostsMutationService;
      await expect(posts.createPost({ userId: 'user', body: 'Answer', visibility: 'verifiedOnly',
        kind: 'checkin', checkinDayKey: '2026-09-08', checkinPrompt: 'Question' } as never))
        .rejects.toThrow('Check-ins open at 5pm ET');
    } finally { jest.useRealTimers(); }
  });
});
