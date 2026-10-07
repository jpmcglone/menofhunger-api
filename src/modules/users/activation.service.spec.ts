import { ActivationService } from './activation.service';

import { PostsReadService } from '../posts-read/posts-read.service';
function setup(verified = true) {
  const prisma = {
    user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn().mockResolvedValue({ verifiedStatus: verified ? 'manual' : 'none', verifiedAt: new Date('2026-09-20T12:00:00Z'), activationCelebratedAt: null }) },
    verificationRequest: { findFirst: jest.fn().mockResolvedValue({ status: 'pending' }) },
    follow: { findFirst: jest.fn().mockResolvedValue(null) },
    post: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const realtime = { emitMeUpdated: jest.fn().mockResolvedValue(undefined) };
  return { prisma, realtime, service: new ActivationService(prisma as never, realtime as never, new PostsReadService(prisma as never as never)) };
}

describe('ActivationService', () => {
  it('keeps pending verification separate from approval and ignores preapproval posts', async () => {
    const { service, prisma } = setup(false);
    expect(await service.get('member')).toEqual({ completionSeen: false, phase: 'before_approval', verificationRequested: true, verificationPending: true, followed: false, contributed: false, replied: false, returned: false });
    expect(prisma.post.findFirst).not.toHaveBeenCalled();
  });
  it('does not treat a rejected request as pending or completed', async () => {
    const { service, prisma } = setup(false);
    prisma.verificationRequest.findFirst.mockResolvedValue({ status: 'rejected' });
    expect(await service.get('member')).toMatchObject({ verificationRequested: false, verificationPending: false });
  });
  it('excludes drafts, private notes, deleted posts, reposts, and activity before approval', async () => {
    const { service, prisma } = setup();
    await service.get('member');
    expect(prisma.post.findFirst.mock.calls[0][0].where).toEqual({ userId: 'member', deletedAt: null, isDraft: false, scheduledAt: null, visibility: { not: 'onlyMe' }, kind: { in: ['regular', 'checkin'] }, createdAt: { gte: new Date('2026-09-20T12:00:00Z') } });
    expect(prisma.post.findFirst.mock.calls[1][0].where.parent).toEqual({ userId: { not: 'member' }, deletedAt: null, user: { isBot: false } });
  });
  it('counts a later UTC day, including month boundaries, without requiring 24 hours', async () => {
    const { service, prisma } = setup();
    prisma.post.findFirst.mockResolvedValueOnce({ createdAt: new Date('2026-09-30T23:59:59Z') }).mockResolvedValueOnce({ id: 'reply' }).mockResolvedValueOnce({ id: 'next-day' });
    expect(await service.get('member')).toMatchObject({ contributed: true, replied: true, returned: true });
    expect(prisma.post.findFirst.mock.calls[2][0].where.createdAt).toEqual({ gte: new Date('2026-10-01T00:00:00Z') });
  });
  it('never counts either seeded account as discovery', async () => {
    const { service, prisma } = setup(false);
    await service.get('member');
    expect(prisma.follow.findFirst.mock.calls[0][0].where.following.NOT).toHaveLength(2);
    expect(prisma.follow.findFirst.mock.calls[0][0].where.followerId).toBe('member');
  });
});


describe('completion presentation claims', () => {
  it('rejects incomplete and before-approval progress without writing', async () => {
    for (const approved of [false, true]) {
      const { service, prisma } = setup(approved);
      expect(await service.claimCompletion('member')).toEqual({ present: false });
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    }
  });
  it('scopes the atomic claim to the authenticated account and only notifies the winner', async () => {
    const { service, prisma, realtime } = setup();
    jest.spyOn(service, 'get').mockResolvedValue({ phase: 'approved', completionSeen: false,
      verificationRequested: true, verificationPending: false, followed: true,
      contributed: true, replied: true, returned: true });
    prisma.user.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await Promise.all([service.claimCompletion('member'), service.claimCompletion('member')]))
      .toEqual([{ present: true }, { present: false }]);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'member', activationCelebratedAt: null },
      data: { activationCelebratedAt: expect.any(Date) },
    });
    expect(realtime.emitMeUpdated).toHaveBeenCalledTimes(1);
    expect(realtime.emitMeUpdated).toHaveBeenCalledWith('member', 'activation-completed');
  });
  it('suppresses completion on a new device when the account has already seen it', async () => {
    const { service, prisma } = setup();
    prisma.user.findUnique.mockResolvedValue({ verifiedStatus: 'manual', verifiedAt: null,
      activationCelebratedAt: new Date() });
    expect((await service.get('member')).completionSeen).toBe(true);
    expect(await service.claimCompletion('member')).toEqual({ present: false });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
  it('does not report a presentation after a failed database write', async () => {
    const { service, prisma, realtime } = setup();
    jest.spyOn(service, 'get').mockResolvedValue({ phase: 'approved', completionSeen: false,
      verificationRequested: true, verificationPending: false, followed: true,
      contributed: true, replied: true, returned: true });
    prisma.user.updateMany.mockRejectedValue(new Error('offline'));
    await expect(service.claimCompletion('member')).rejects.toThrow('offline');
    expect(realtime.emitMeUpdated).not.toHaveBeenCalled();
  });
});
