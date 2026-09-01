import { CallsSideEffectsHandler } from './calls-side-effects.handler';
import type { CallSessionRecord } from './call-session.store';

function ringing(over: Partial<CallSessionRecord> = {}): CallSessionRecord {
  return {
    id: 'call-1',
    conversationId: 'conv-1',
    conversationType: 'direct',
    type: 'video',
    status: 'ringing',
    startedByUserId: 'alice',
    startedByAdmin: false,
    startedAt: '2026-09-01T12:00:00.000Z',
    activeAt: null,
    emptyAt: null,
    endedAt: null,
    capacity: 2,
    messageId: 'msg-1',
    ringTargetUserId: 'bob',
    peakParticipantCount: 1,
    participants: [],
    ...over,
  };
}

function makeHandler(opts: { record: CallSessionRecord | null; hasVoip?: boolean; configured?: boolean }) {
  const registry = { register: jest.fn() };
  const store = { getByCallId: jest.fn(async () => opts.record) };
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({
        id: 'alice',
        username: 'alice',
        name: 'Alice',
        premium: true,
        premiumPlus: false,
        isOrganization: false,
        verifiedStatus: 'manual',
        avatarKey: null,
        avatarUpdatedAt: null,
      })),
    },
  };
  const apns = {
    configured: jest.fn(() => opts.configured ?? true),
    hasVoipToken: jest.fn(async () => opts.hasVoip ?? true),
    sendVoip: jest.fn(async () => undefined),
  };
  const appConfig = { r2: jest.fn(() => null) };
  const handler = new CallsSideEffectsHandler(registry as any, store as any, prisma as any, apns as any, appConfig as any);
  return { handler, registry, apns, prisma };
}

const PAYLOAD = { callId: 'call-1', conversationId: 'conv-1', callerUserId: 'alice', calleeUserId: 'bob' };

describe('CallsSideEffectsHandler', () => {
  it('registers call.direct.ringing', () => {
    const { handler, registry } = makeHandler({ record: ringing() });
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith('call.direct.ringing', expect.any(Function));
  });

  it('sends a PushKit ring with the caller and an expiry matching the ring timeout', async () => {
    const { handler, apns } = makeHandler({ record: ringing() });
    await handler.onDirectRinging(PAYLOAD);
    expect(apns.sendVoip).toHaveBeenCalledWith('bob', {
      callId: 'call-1',
      conversationId: 'conv-1',
      type: 'video',
      caller: expect.objectContaining({ id: 'alice', username: 'alice', name: 'Alice', avatarUrl: null }),
      expiresAt: '2026-09-01T12:00:40.000Z',
    });
  });

  it('is a no-op once the call stopped ringing (retry after answer/decline)', async () => {
    const answered = makeHandler({ record: ringing({ status: 'active' }) });
    await answered.handler.onDirectRinging(PAYLOAD);
    expect(answered.apns.sendVoip).not.toHaveBeenCalled();

    const gone = makeHandler({ record: null });
    await gone.handler.onDirectRinging(PAYLOAD);
    expect(gone.apns.sendVoip).not.toHaveBeenCalled();
  });

  it('skips callees without a PushKit token and never reads the caller row for them', async () => {
    const { handler, apns, prisma } = makeHandler({ record: ringing(), hasVoip: false });
    await handler.onDirectRinging(PAYLOAD);
    expect(apns.sendVoip).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('refuses to ring anyone other than the recorded callee', async () => {
    const { handler, apns } = makeHandler({ record: ringing({ ringTargetUserId: 'carol' }) });
    await handler.onDirectRinging(PAYLOAD);
    expect(apns.sendVoip).not.toHaveBeenCalled();
  });
});
