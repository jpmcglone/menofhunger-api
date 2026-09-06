import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminAssistantService } from './admin-assistant.service';
import { sessionApi } from '../mcp/mcp-tools';

jest.mock('../mcp/mcp-tools', () => ({
  sessionApi: jest.fn(),
  sharedTools: { sanitize: (value: unknown) => value, capabilities: () => [], createTools: () => [], schema: () => ({}), guidance: () => 'Metric guide' },
}));

function fixture() {
  const before = { id: 'f1', subject: 'A bug', status: 'new', adminNote: null, updatedAt: new Date('2026-09-01') };
  const action: any = { id: 'action1', turnId: 'turn1', operation: 'feedback_update', targetId: 'f1', title: 'Update feedback', path: '/admin/feedback', before: JSON.parse(JSON.stringify(before)), input: { status: 'triaged' }, status: 'pending', expiresAt: new Date(Date.now() + 600000), resultMessage: null };
  const prisma: any = {
    feedback: { findUnique: jest.fn(async () => before) },
    adminAssistantAction: {
      findFirst: jest.fn(async ({ where }) => where.turn.userId === 'admin1' ? { ...action } : null),
      findUniqueOrThrow: jest.fn(async () => ({ ...action })),
      updateMany: jest.fn(async ({ where, data }) => {
        if (action.status !== where.status) return { count: 0 };
        Object.assign(action, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }) => Object.assign(action, data)),
    },
    adminAssistantTurn: { findUnique: jest.fn(async () => null), count: jest.fn(async () => 0) },
  };
  const session: any = { user: { id: 'admin1', siteAdmin: true }, expiresAt: new Date(Date.now() + 3600000), impersonatedByUserId: null, operatedByUserId: null };
  const auth: any = { meFromSessionToken: jest.fn(async () => session) };
  const api = { request: jest.fn(async () => ({ data: { id: 'f1' } })) };
  (sessionApi as jest.Mock).mockReturnValue(api);
  const realtime: any = { emitAdminUpdated: jest.fn() };
  const ai: any = { isConfigured: () => true, respond: jest.fn() };
  const redis: any = { withLock: jest.fn(async () => null) };
  const svc = new AdminAssistantService(prisma, auth, {} as any, redis, realtime, ai, {} as any, { getGlobalSettings: async () => ({ enabled: true }) } as any);
  return { svc, prisma, action, before, session, auth, api, realtime, ai };
}

describe('Admin assistant authorization and action receipts', () => {
  it.each(['impersonatedByUserId', 'operatedByUserId'])('rejects %s sessions before reads or writes', async (field) => {
    const { svc, session, api, prisma } = fixture();
    session[field] = 'other';
    await expect(svc.decide('admin1', 'token', 'action1', 'confirm')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.adminAssistantAction.findFirst).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
  });
  it('scopes proposals to their owner', async () => {
    const { svc, session, api } = fixture();
    session.user.id = 'admin2';
    await expect(svc.decide('admin2', 'token', 'action1', 'confirm')).rejects.toBeInstanceOf(NotFoundException);
    expect(api.request).not.toHaveBeenCalled();
  });
  it('atomically claims duplicate confirmations and preserves JSONB key-order independence', async () => {
    const { svc, action, before, api, realtime } = fixture();
    action.before = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(before))).reverse());
    await Promise.all([svc.decide('admin1', 'token', 'action1', 'confirm'), svc.decide('admin1', 'token', 'action1', 'confirm')]);
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(api.request).toHaveBeenCalledWith('admin/feedback/f1', { method: 'PATCH', body: { status: 'triaged' } });
    expect(action.status).toBe('complete');
    expect(realtime.emitAdminUpdated).toHaveBeenCalledWith('admin1', expect.objectContaining({ kind: 'assistant' }));
  });
  it('does not execute cancelled or expired proposals', async () => {
    for (const decision of ['cancel', 'confirm'] as const) {
      const { svc, action, api } = fixture();
      if (decision === 'confirm') action.expiresAt = new Date(0);
      const result = await svc.decide('admin1', 'token', 'action1', decision);
      expect(result.status).toBe(decision === 'cancel' ? 'cancelled' : 'expired');
      expect(api.request).not.toHaveBeenCalled();
    }
  });
  it('rejects changed targets instead of silently overwriting them', async () => {
    const { svc, before, api } = fixture();
    before.status = 'resolved';
    expect((await svc.decide('admin1', 'token', 'action1', 'confirm')).status).toBe('stale');
    expect(api.request).not.toHaveBeenCalled();
  });
  it('never retries an uncertain mutation', async () => {
    const { svc, api } = fixture();
    api.request.mockRejectedValue(new Error('timeout'));
    expect((await svc.decide('admin1', 'token', 'action1', 'confirm')).status).toBe('uncertain');
    await svc.decide('admin1', 'token', 'action1', 'confirm');
    expect(api.request).toHaveBeenCalledTimes(1);
  });
  it('revalidates the stored controller schema before executing', async () => {
    const { svc, action, api } = fixture();
    action.input = { status: 'delete_everything' };
    expect((await svc.decide('admin1', 'token', 'action1', 'confirm')).status).toBe('failed');
    expect(api.request).not.toHaveBeenCalled();
  });
  it('does not run a second paid request when an idempotency key already exists', async () => {
    const { svc, prisma, ai } = fixture();
    prisma.adminAssistantTurn.findUnique.mockResolvedValue({ id: 'turn1', userId: 'admin1', question: 'Hello', status: 'complete', answer: 'Hi', sources: [], actions: [], createdAt: new Date() });
    expect((await svc.ask('admin1', 'token', { id: 'turn1', message: 'Hello' })).answer).toBe('Hi');
    await expect(svc.ask('admin1', 'token', { id: 'turn1', message: 'Different' })).rejects.toBeInstanceOf(ConflictException);
    expect(ai.respond).not.toHaveBeenCalled();
  });
  it('prevents overlapping admin conversations from racing', async () => {
    const { svc, ai } = fixture();
    await expect(svc.ask('admin1', 'token', { id: 'new', message: 'Hello' })).rejects.toBeInstanceOf(ConflictException);
    expect(ai.respond).not.toHaveBeenCalled();
  });
});
