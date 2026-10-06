import { createHash } from 'node:crypto';
import { ChannelMarvScopeService, marvChannelSourceWhere } from './channel-marv-scope.service';

const input = { groupId: 'group-a', channelId: 'private-x', messageId: 'trigger', requesterId: 'human' };
function setup() {
  const db = {
    user: { findUnique: jest.fn().mockResolvedValue({ premium: true }), findFirst: jest.fn().mockResolvedValue({ id: 'marv' }) },
    marvinUserSettings: { findUnique: jest.fn().mockResolvedValue({ aiConsentAt: new Date(), aiConsentVersion: 2 }) },
    communityGroupMember: { findUnique: jest.fn().mockResolvedValue({ status: 'active', role: 'member', createdAt: new Date(1) }) },
    groupChannelAccess: { findUnique: jest.fn().mockResolvedValue({ createdAt: new Date(2) }) },
    message: { findFirst: jest.fn().mockResolvedValue({ id: 'trigger', body: '@marv help', conversationId: 'conversation' }), findMany: jest.fn().mockResolvedValue([]) },
  };
  const channel = { id: 'private-x', conversationId: 'conversation', privacy: 'private', archivedAt: null };
  const access = { enabled: () => true, channel: jest.fn().mockResolvedValue({ channel }) };
  const config = { groupChannels: () => ({ marvEnabled: true }), marvBot: () => ({ enabled: true, username: 'marv' }) };
  const service = new ChannelMarvScopeService(db as never, config as never, access as never, {} as never);
  return { db, access, service };
}
describe('MARV channel scope', () => {
  it('never includes a sibling private channel or another group in retrieval', () => {
    expect(marvChannelSourceWhere('a', 'x', false)).toEqual({ groupId: 'a', group: { deletedAt: null }, OR: [{ privacy: 'normal' }] });
    expect(marvChannelSourceWhere('a', 'x', true)).toEqual({ groupId: 'a', group: { deletedAt: null }, OR: [{ privacy: 'normal' }, { id: 'x', privacy: 'private' }] });
  });
  it('requires an explicit channel invitation even with group membership', async () => {
    const { service, db } = setup(); db.groupChannelAccess.findUnique.mockResolvedValue(null as never);
    await expect(service.authorize(input)).rejects.toThrow();
  });
  it('cancels an old generation after removal and reinvitation', async () => {
    const { service, db } = setup(); const { grant } = await service.authorize(input);
    db.groupChannelAccess.findUnique.mockResolvedValue({ createdAt: new Date(3) });
    await expect(service.authorize(input, grant)).rejects.toThrow('participation changed');
  });
  it.each(['consent', 'premium', 'admin', 'mention', 'group', 'requester'])('revokes generation after %s access changes', async reason => {
    const { service, db, access } = setup(); const { grant } = await service.authorize(input);
    if (reason === 'consent') db.marvinUserSettings.findUnique.mockResolvedValue({ aiConsentAt: null, aiConsentVersion: 2 } as never);
    if (reason === 'premium') db.user.findUnique.mockResolvedValue({ premium: false });
    if (reason === 'admin') db.marvinUserSettings.findUnique.mockResolvedValue({ aiConsentAt: new Date(), aiConsentVersion: 2, disabledByAdmin: true } as never);
    if (reason === 'mention') db.message.findFirst.mockResolvedValue({ id: 'trigger', body: 'help', conversationId: 'conversation' });
    if (reason === 'group') db.communityGroupMember.findUnique.mockResolvedValue({ status: 'pending', role: 'member', createdAt: new Date(1) });
    if (reason === 'requester') access.channel.mockRejectedValue(new Error('removed'));
    await expect(service.authorize(input, grant)).rejects.toThrow();
  });
  it('rejects deleted or edited evidence before output delivery', async () => {
    const { service, db } = setup(); const { grant } = await service.authorize(input);
    const evidence = [{ id: 'source', channelId: 'private-x', digest: createHash('sha256').update('original').digest('hex') }];
    await expect(service.validateEvidence(input, grant, evidence)).rejects.toThrow('Source content changed');
    db.message.findMany.mockResolvedValue([{ id: 'source', body: 'edited' }] as never);
    await expect(service.validateEvidence(input, grant, evidence)).rejects.toThrow('Source content changed');
    db.message.findMany.mockResolvedValue([{ id: 'source', body: 'original' }] as never);
    await expect(service.validateEvidence(input, grant, evidence)).resolves.toBeDefined();
  });
});
