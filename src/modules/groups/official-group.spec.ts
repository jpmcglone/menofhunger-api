import { joinOfficialGroup } from './official-group';

function prismaWith(tx: Record<string, unknown>) {
  return { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as never;
}

const user = { bannedAt: null, isBot: false, isOrganization: false, verifiedStatus: 'manual' };

describe('joinOfficialGroup', () => {
  it('adds a verified person and counts them once', async () => {
    const create = jest.fn(); const update = jest.fn();
    const tx = {
      communityGroup: { findFirst: async () => ({ id: 'g1' }), update },
      user: { findUnique: async () => user },
      communityGroupMember: { findUnique: async () => null, create, update: jest.fn() },
    };
    expect(await joinOfficialGroup(prismaWith(tx), 'u1')).toBe(true);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ groupId: 'g1', userId: 'u1', status: 'active' }) });
    expect(update).toHaveBeenCalledWith({ where: { id: 'g1' }, data: { memberCount: { increment: 1 } } });
  });

  it('is a no-op for existing members, bots, unverified people, or a missing group', async () => {
    const base = { communityGroup: { findFirst: async () => ({ id: 'g1' }), update: jest.fn() }, user: { findUnique: async () => user }, communityGroupMember: { findUnique: async () => ({ status: 'active' }), create: jest.fn(), update: jest.fn() } };
    expect(await joinOfficialGroup(prismaWith(base), 'u1')).toBe(false);
    expect(await joinOfficialGroup(prismaWith({ ...base, user: { findUnique: async () => ({ ...user, isBot: true }) } }), 'u1')).toBe(false);
    expect(await joinOfficialGroup(prismaWith({ ...base, user: { findUnique: async () => ({ ...user, verifiedStatus: 'none' }) } }), 'u1')).toBe(false);
    expect(await joinOfficialGroup(prismaWith({ ...base, communityGroup: { findFirst: async () => null, update: jest.fn() } }), 'u1')).toBe(false);
    expect(base.communityGroupMember.create).not.toHaveBeenCalled();
  });
});
