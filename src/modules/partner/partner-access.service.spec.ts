import { PartnerAccessService } from './partner-access.service';

describe('partner grant authority', () => {
  const human = { id: 'human', username: 'member', accountKind: 'person', bannedAt: null };
  const page = { id: 'page', username: 'page', accountKind: 'page', bannedAt: null };
  function harness() {
    const grant = { id: 'grant', clientId: 'client', userId: 'page', operatorUserId: 'human', expiresAt: new Date(Date.now() + 100000), revokedAt: null as Date | null };
    const prisma: any = {
      user: { findUnique: jest.fn(async ({ where }) => where.id === 'human' ? human : page) },
      userPageOperator: { findUnique: jest.fn(async () => ({ operatorUserId: 'human', pageUserId: 'page' })) },
      partnerClient: { findUnique: jest.fn(async () => ({ active: true })) },
      partnerGrant: { findUnique: jest.fn(async () => grant) },
    };
    return { grant, prisma, access: new PartnerAccessService(prisma) };
  }
  it('keeps human identity separate from selected page', async () => {
    const h = harness(); const result = await h.access.grant('grant', 'client');
    expect(result.grant.userId).toBe('page'); expect(result.grant.operatorUserId).toBe('human');
  });
  it('checks the original operator on every access, including after removal', async () => {
    const h = harness(); await h.access.grant('grant');
    h.prisma.userPageOperator.findUnique.mockResolvedValue(null);
    await expect(h.access.grant('grant')).rejects.toMatchObject({ status: 403 });
  });
  it.each(['expired', 'revoked', 'wrong-client', 'suspended'])('rejects %s grants', async scenario => {
    const h = harness();
    if (scenario === 'expired') h.grant.expiresAt = new Date(0);
    if (scenario === 'revoked') h.grant.revokedAt = new Date();
    if (scenario === 'suspended') h.prisma.partnerClient.findUnique.mockResolvedValue({ active: false });
    await expect(h.access.grant('grant', scenario === 'wrong-client' ? 'other' : 'client')).rejects.toMatchObject({ status: 401 });
  });
  it('never treats operating a page as ownership of another human account', async () => {
    const h = harness(); h.prisma.user.findUnique.mockImplementation(async ({ where }: any) => ({ ...human, id: where.id }));
    await expect(h.access.assertAccount('other-human', 'human')).rejects.toMatchObject({ status: 403 });
  });
});
