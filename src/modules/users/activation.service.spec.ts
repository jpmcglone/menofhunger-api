import { ActivationService } from './activation.service';

function setup(verified = true) {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ verifiedStatus: verified ? 'manual' : 'none', verifiedAt: new Date('2026-09-20T12:00:00Z') }) },
    verificationRequest: { findFirst: jest.fn().mockResolvedValue({ status: 'pending' }) },
    follow: { findFirst: jest.fn().mockResolvedValue(null) },
    post: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  return { prisma, service: new ActivationService(prisma as never) };
}

describe('ActivationService', () => {
  it('keeps pending verification separate from approval and ignores preapproval posts', async () => {
    const { service, prisma } = setup(false);
    expect(await service.get('member')).toEqual({ phase: 'before_approval', verificationRequested: true, verificationPending: true, followed: false, contributed: false, replied: false, returned: false });
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
