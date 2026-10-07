import { ChannelAccessService } from './channel-access.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AppConfigService } from '../app/app-config.service';

function setup(member: unknown, enabled = true, groupIds: string[] = []) {
  const prisma = {
    communityGroupMember: { findUnique: jest.fn().mockResolvedValue(member) },
    groupChannel: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const config = { groupChannels: () => ({ enabled, groupIds }) };
  return { service: new ChannelAccessService(prisma as unknown as PrismaService, config as AppConfigService), prisma };
}
const active = { status: 'active', role: 'owner', group: { deletedAt: null }, user: { bannedAt: null, isBot: false, verifiedStatus: 'manual', premium: false, premiumPlus: false } };

describe('channel access boundary', () => {
  it.each([null, { ...active, status: 'pending' }, { ...active, user: { ...active.user, bannedAt: new Date() } }, { ...active, user: { ...active.user, verifiedStatus: 'none' } }, { ...active, user: { ...active.user, verifiedStatus: 'none', premium: true, premiumPlus: true } }, { ...active, group: { deletedAt: new Date() } }])('hides channels from ineligible membership %p', async member => {
    const { service, prisma } = setup(member);
    await expect(service.channel('viewer', 'group', 'private')).rejects.toThrow('Channel unavailable.');
    expect(prisma.groupChannel.findFirst).not.toHaveBeenCalled();
  });
  it('does not give an uninvited owner a private-channel bypass', async () => {
    const { service, prisma } = setup(active);
    await expect(service.channel('owner', 'group', 'private')).rejects.toThrow('Channel unavailable.');
    expect(prisma.groupChannel.findFirst).toHaveBeenCalledWith({ where: { id: 'private', groupId: 'group', OR: [{ privacy: 'normal' }, { access: { some: { userId: 'owner' } } }] } });
  });
  it('applies rollout gating before looking up membership or metadata', async () => {
    for (const [enabled, groups] of [[false, []], [true, ['pilot']]] as const) {
      const { service, prisma } = setup(active, enabled, [...groups]);
      await expect(service.member('owner', 'other')).rejects.toThrow();
      expect(prisma.communityGroupMember.findUnique).not.toHaveBeenCalled();
    }
  });
});
