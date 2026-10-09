import { GroupEmailService } from './group-email.service';

function setup() {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', name: 'John', email: 'john@example.com', emailVerifiedAt: new Date(), notificationPreferences: { emailInstantHighSignal: true } }) },
    communityGroup: { findFirst: jest.fn().mockResolvedValue({ slug: 'builders', name: 'Builders' }) },
    communityGroupInvite: { findFirst: jest.fn().mockResolvedValue({ id: 'invite1', updatedAt: new Date('2026-10-09T12:00:00Z'), lastNotifiedAt: null }) },
    communityGroupMember: { findFirst: jest.fn().mockResolvedValue({ updatedAt: new Date('2026-10-09T12:00:00Z') }) },
  };
  const email = { sendText: jest.fn().mockResolvedValue({ sent: true }) };
  const config = { email: () => ({ fromEmail: { notifications: 'hello@menofhunger.com' } }), frontendBaseUrl: () => 'https://menofhunger.com' };
  return { prisma, email, service: new GroupEmailService(prisma as never, email as never, config as never) };
}

describe('group email delivery', () => {
  it('prioritizes a requested invitation without bypassing its email preference', async () => {
    const { service, email } = setup();
    await expect(service.send({ kind: 'invite', recipientUserId: 'u1', groupId: 'g1', inviteId: 'invite1' })).resolves.toBe(true);
    expect(email.sendText).toHaveBeenCalledWith(expect.objectContaining({
      category: 'service', preference: 'emailInstantHighSignal', eventKey: 'group-invite:invite1:2026-10-09T12:00:00.000Z',
    }));
  });

  it('does not send an invitation after it was cancelled or expired', async () => {
    const { service, prisma, email } = setup();
    prisma.communityGroupInvite.findFirst.mockResolvedValue(null);
    await expect(service.send({ kind: 'invite', recipientUserId: 'u1', groupId: 'g1', inviteId: 'invite1' })).resolves.toBe(false);
    expect(email.sendText).not.toHaveBeenCalled();
  });

  it('does not send an approval after membership was removed', async () => {
    const { service, prisma, email } = setup();
    prisma.communityGroupMember.findFirst.mockResolvedValue(null);
    await expect(service.send({ kind: 'approved', recipientUserId: 'u1', groupId: 'g1' })).resolves.toBe(false);
    expect(email.sendText).not.toHaveBeenCalled();
  });

  it('never includes a private channel name or excerpt in a queued email', async () => {
    const { service, email } = setup();
    await service.send({ kind: 'mention', recipientUserId: 'u1', groupId: 'g1', messageId: 'm1', channel: { id: 'c1', label: 'Private finance', isPrivate: true }, excerpt: 'Sensitive details' });
    const request = email.sendText.mock.calls[0]![0];
    expect(request.text).not.toContain('Private finance');
    expect(request.html).not.toContain('Sensitive details');
    expect(request.eventKey).toBe('channel-mention:m1:u1');
    expect(request.retrySafe).not.toBe(true);
  });
});
