import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PartnerWebhooksService } from './partner-webhooks.service';
import { sealSecret } from '../../common/crypto/secret-box';
import { sendPartnerWebhook } from './partner-webhook.transport';
jest.mock('./partner-webhook.transport', () => ({ sendPartnerWebhook: jest.fn() }));

describe('partner webhook dispatch privacy', () => {
  function harness() {
    const secret = 'fixture-encryption-at-least-32-characters';
    const event: any = { id: 'event', userId: 'member', type: 'post.updated', resourceKind: 'post', resourceId: 'post', version: 10n, createdAt: new Date() };
    const grant = { id: 'grant', userId: 'member', clientId: 'client', scopes: ['content:read', 'webhooks:read'] };
    const client = { id: 'client', active: true, webhookUrl: 'https://partner.example/webhook', webhookSecretEnc: sealSecret('fixture-webhook-secret', secret), webhookEvents: ['post.updated', 'post.removed', 'comment.removed', 'connection.revoked'], scopes: grant.scopes };
    const prisma: any = { partnerWebhookDelivery: { findUnique: jest.fn(async () => ({ id: 'delivery', eventId: event.id, grantId: grant.id, clientId: client.id, status: 'pending', attempts: 0, createdAt: new Date() })), updateMany: jest.fn(async () => ({ count: 1 })), update: jest.fn(async () => ({})) },
      partnerEvent: { findUnique: jest.fn(async () => event), findFirst: jest.fn(async () => null) },
      partnerGrant: { findUnique: jest.fn(async () => grant) }, partnerClient: { findUnique: jest.fn(async () => client) } };
    const access: any = { grant: jest.fn(async () => ({ grant, client })) };
    const reads: any = { post: jest.fn(async () => ({ id: 'post', body: 'Current public body' })) };
    const service = new PartnerWebhooksService(prisma, { partner: () => ({ webhooks: true, encryptionKey: secret }) } as any, {} as any, {} as any, access, reads);
    jest.mocked(sendPartnerWebhook).mockReset().mockResolvedValue(204);
    return { service, event, grant, client, prisma, access, reads };
  }
  it('builds the current public payload only when dispatching', async () => {
    const h = harness(); await h.service.deliver('delivery');
    const body = JSON.parse(jest.mocked(sendPartnerWebhook).mock.calls[0][1]);
    expect(body).toMatchObject({ origin: 'menofhunger', version: '10', data: { body: 'Current public body' } });
  });
  it('drops queued content that became private', async () => {
    const h = harness(); h.reads.post.mockRejectedValue(new NotFoundException()); await h.service.deliver('delivery');
    expect(sendPartnerWebhook).not.toHaveBeenCalled(); expect(h.prisma.partnerWebhookDelivery.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) }));
  });
  it('drops ordinary deliveries after revocation', async () => {
    const h = harness(); h.access.grant.mockRejectedValue(new UnauthorizedException()); await h.service.deliver('delivery');
    expect(sendPartnerWebhook).not.toHaveBeenCalled();
  });
  it('permits only identifiers on removals and a minimal terminal revocation', async () => {
    const h = harness(); h.event.type = 'post.removed'; await h.service.deliver('delivery');
    expect(JSON.parse(jest.mocked(sendPartnerWebhook).mock.calls[0][1]).data).toEqual({ id: 'post' });
    expect(h.reads.post).not.toHaveBeenCalled();
    h.event.type = 'comment.removed'; await h.service.deliver('delivery');
    expect(JSON.parse(jest.mocked(sendPartnerWebhook).mock.calls[1][1]).data).toEqual({ id: 'post' });
    h.event.type = 'connection.revoked'; h.event.resourceId = 'grant'; await h.service.deliver('delivery');
    expect(JSON.parse(jest.mocked(sendPartnerWebhook).mock.calls[2][1]).data).toEqual({ id: 'grant', revoked: true });
  });
  it('cancels superseded events and removed client scopes', async () => {
    const h = harness(); h.prisma.partnerEvent.findFirst.mockResolvedValue({ id: 'newer' }); await h.service.deliver('delivery');
    expect(sendPartnerWebhook).not.toHaveBeenCalled();
    h.client.scopes = []; await h.service.deliver('delivery'); expect(sendPartnerWebhook).not.toHaveBeenCalled();
  });
});
