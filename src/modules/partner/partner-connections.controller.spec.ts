import { PartnerConnectionsController } from './partner-connections.controller';
import { PartnerConnectionsService } from './partner-connections.service';

describe('connected app status', () => {
  function harness() {
    const grant = { id: 'grant', userId: 'page', operatorUserId: 'former-operator', clientId: 'client', scopes: ['account:read'], createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
    const client = { id: 'client', name: 'Partner', active: true };
    const access: any = { assertAccount: jest.fn(async () => ({})) };
    const prisma: any = { partnerGrant: { findMany: jest.fn(async () => [grant]) }, partnerClient: { findMany: jest.fn(async () => [client]) } };
    return { grant, client, access, controller: new PartnerConnectionsController(new PartnerConnectionsService(prisma, access)) };
  }
  it('shows removed operator authority as paused instead of active access', async () => {
    const h = harness(); h.access.assertAccount.mockRejectedValue(new Error('Operator removed'));
    const result = await h.controller.list({ user: { id: 'page' } } as any);
    expect(result.data[0].status).toBe('needs_reauthorization');
    expect(h.access.assertAccount).toHaveBeenCalledWith('page', 'former-operator');
  });
  it('distinguishes expiry and administrative suspension', async () => {
    const h = harness(); h.client.active = false;
    expect((await h.controller.list({ user: { id: 'page' } } as any)).data[0].status).toBe('suspended');
    h.grant.expiresAt = new Date(0);
    expect((await h.controller.list({ user: { id: 'page' } } as any)).data[0].status).toBe('expired');
    expect(h.access.assertAccount).not.toHaveBeenCalled();
  });
  it('reports active access only after checking current authority', async () => {
    const h = harness();
    expect((await h.controller.list({ user: { id: 'page' } } as any)).data[0].status).toBe('active');
    expect(h.access.assertAccount).toHaveBeenCalledTimes(1);
  });
});
