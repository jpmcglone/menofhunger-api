import { NotFoundException } from '@nestjs/common';
import { CallsService, callMessageBody, formatCallDuration } from './calls.service';
import { CallSessionStore, type CallSessionRecord } from './call-session.store';
import type { CallConversationContext } from '../messages/messages.service';

// ─── In-memory stand-in for the Redis-backed store ───────────────────────────

class FakeStore {
  readonly byConversation = new Map<string, CallSessionRecord>();
  readonly seatByUser = new Map<string, string>();

  async getByConversationId(id: string) {
    const r = this.byConversation.get(id);
    return r ? structuredClone(r) : null;
  }
  async getByCallId(callId: string) {
    for (const r of this.byConversation.values()) if (r.id === callId) return structuredClone(r);
    return null;
  }
  async getManyByConversationIds(ids: string[]) {
    const out = new Map<string, CallSessionRecord>();
    for (const id of ids) {
      const r = this.byConversation.get(id);
      if (r) out.set(id, structuredClone(r));
    }
    return out;
  }
  readonly live = new Set<string>();

  async save(r: CallSessionRecord) {
    this.byConversation.set(r.conversationId, structuredClone(r));
    for (const p of r.participants) this.seatByUser.set(p.userId, r.id);
    this.live.add(r.conversationId);
  }
  async delete(r: { id: string; conversationId: string }) {
    this.byConversation.delete(r.conversationId);
    this.live.delete(r.conversationId);
  }
  async listLiveConversationIds() {
    return [...this.live];
  }
  async forgetLiveConversation(id: string) {
    this.live.delete(id);
  }
  async getCallIdForUser(userId: string) {
    const callId = this.seatByUser.get(userId) ?? null;
    if (!callId) return null;
    const rec = await this.getByCallId(callId);
    if (!rec || !rec.participants.some((p) => p.userId === userId)) {
      this.seatByUser.delete(userId);
      return null;
    }
    return callId;
  }
  async releaseSeat(userId: string, callId: string) {
    if (this.seatByUser.get(userId) === callId) this.seatByUser.delete(userId);
  }
  async inCallByUserIds(ids: string[]) {
    return new Set(ids.filter((id) => this.seatByUser.has(id)));
  }
  async withConversationLock<T>(_id: string, fn: () => Promise<T>) {
    return await fn();
  }
}

type Member = Partial<CallConversationContext['participants'][number]> & { userId: string };

function member(userId: string, over: Partial<Member> = {}): CallConversationContext['participants'][number] {
  return {
    userId,
    status: 'accepted',
    verified: true,
    siteAdmin: false,
    isBot: false,
    banned: false,
    ...over,
  };
}

function makeService(conversations: Record<string, CallConversationContext>) {
  const store = new FakeStore();
  const messages = {
    getCallConversationContext: jest.fn(async ({ userId, conversationId }: { userId: string; conversationId: string }) => {
      const c = conversations[conversationId];
      if (!c || !c.participants.some((p) => p.userId === userId)) throw new NotFoundException('Conversation not found.');
      return c;
    }),
    listConversationMemberUserIds: jest.fn(async (conversationId: string) =>
      (conversations[conversationId]?.participants ?? []).map((p) => p.userId),
    ),
    createCallMessage: jest.fn(async (p: { senderId: string }) => ({ id: 'msg-1', sender: { id: p.senderId, username: 'caller' } })),
    updateCallMessage: jest.fn(async () => undefined),
  };
  const realtime = {
    emitCallsIncoming: jest.fn(),
    emitCallsUpdated: jest.fn(),
    emitRtcSignal: jest.fn(),
    emitCallsSeatTaken: jest.fn(),
    emitPresenceCallChanged: jest.fn(),
  };
  const jobs = {
    enqueue: jest.fn(async () => ({})),
    removeById: jest.fn(async () => undefined),
  };
  const iceServers = { resolve: jest.fn(async () => [{ urls: ['stun:stun.example.com'] }]) };
  const sideEffects = { dispatch: jest.fn() };
  /** Socket ids presence can prove are still connected, per user. Tests mutate this to simulate drops. */
  const liveSockets = new Map<string, Set<string>>();
  const presenceRedis = {
    liveSocketIdsForUser: jest.fn(async (userId: string) => new Set(liveSockets.get(userId) ?? [])),
  };
  const svc = new CallsService(
    store as unknown as CallSessionStore,
    messages as any,
    realtime as any,
    jobs as any,
    iceServers as any,
    sideEffects as any,
    presenceRedis as any,
  );
  return { svc, store, messages, realtime, jobs, sideEffects, liveSockets };
}

const DIRECT: CallConversationContext = {
  id: 'conv-direct',
  type: 'direct',
  participants: [member('alice'), member('bob')],
  relationship: null,
};

const GROUP: CallConversationContext = {
  id: 'conv-group',
  type: 'group',
  participants: [member('alice'), member('bob'), member('carol'), member('dave'), member('erin')],
  relationship: null,
};

afterEach(() => jest.restoreAllMocks());

describe('CallsService gating', () => {
  it('rejects a starter who is neither admin nor verified', async () => {
    const { svc } = makeService({
      c: { id: 'c', type: 'direct', participants: [member('alice', { verified: false }), member('bob')], relationship: null },
    });
    const ack = await svc.start({ userId: 'alice', socketId: 's1', conversationId: 'c', type: 'video' });
    expect(ack.error?.code).toBe('not_allowed_to_start');
    expect(ack.call).toBeNull();
  });

  it('lets a verified member call once the DM is accepted, they mutually follow, or they share a group chat', async () => {
    const pendingBob = () => member('bob', { status: 'pending' });
    const { svc, store } = makeService({
      none: { id: 'none', type: 'direct', participants: [member('alice'), pendingBob()], relationship: { mutualFollow: false, sharedGroupConversation: false } },
      mutual: { id: 'mutual', type: 'direct', participants: [member('alice'), pendingBob()], relationship: { mutualFollow: true, sharedGroupConversation: false } },
      group: { id: 'group', type: 'direct', participants: [member('alice'), pendingBob()], relationship: { mutualFollow: false, sharedGroupConversation: true } },
      accepted: { id: 'accepted', type: 'direct', participants: [member('alice'), member('bob')], relationship: null },
    });

    const denied = await svc.start({ userId: 'alice', socketId: 's1', conversationId: 'none', type: 'audio' });
    expect(denied.error?.code).toBe('conversation_not_accepted');

    for (const conversationId of ['mutual', 'group', 'accepted']) {
      const ack = await svc.start({ userId: 'alice', socketId: 's1', conversationId, type: 'audio' });
      expect(ack.error).toBeUndefined();
      expect(ack.call?.status).toBe('ringing');
      await svc.leave({ userId: 'alice', callId: ack.call!.id });
      await store.delete({ id: ack.call!.id, conversationId });
    }
  });

  it('lets an admin call a member who has not accepted and has no relationship', async () => {
    const { svc } = makeService({
      a: {
        id: 'a',
        type: 'direct',
        participants: [member('admin', { siteAdmin: true, verified: false }), member('bob', { status: 'pending', verified: false })],
        relationship: { mutualFollow: false, sharedGroupConversation: false },
      },
    });
    const ack = await svc.start({ userId: 'admin', socketId: 's1', conversationId: 'a', type: 'audio' });
    expect(ack.error).toBeUndefined();
    expect(ack.call?.startedByAdmin).toBe(true);
  });

  it('rejects calling an unverified member unless the caller is an admin', async () => {
    const { svc } = makeService({
      c: { id: 'c', type: 'direct', participants: [member('alice'), member('bob', { verified: false })], relationship: null },
      a: { id: 'a', type: 'direct', participants: [member('admin', { siteAdmin: true }), member('bob', { verified: false })], relationship: null },
    });
    const denied = await svc.start({ userId: 'alice', socketId: 's1', conversationId: 'c', type: 'audio' });
    expect(denied.error?.code).toBe('callee_not_verified');

    const allowed = await svc.start({ userId: 'admin', socketId: 's2', conversationId: 'a', type: 'audio' });
    expect(allowed.error).toBeUndefined();
    expect(allowed.call?.startedByAdmin).toBe(true);
  });

  it('rejects non-members and bots', async () => {
    const { svc } = makeService({
      c: { id: 'c', type: 'direct', participants: [member('alice'), member('marv', { isBot: true })], relationship: null },
    });
    expect((await svc.start({ userId: 'zed', socketId: 's', conversationId: 'c', type: 'video' })).error?.code).toBe('not_member');
    expect((await svc.start({ userId: 'alice', socketId: 's', conversationId: 'c', type: 'video' })).error?.code).toBe('callee_unavailable');
  });

  it('lets an unverified member join only when an admin started the call', async () => {
    const ctx: CallConversationContext = {
      id: 'g',
      type: 'group',
      participants: [member('admin', { siteAdmin: true }), member('alice'), member('newbie', { verified: false })],
      relationship: null,
    };
    const { svc } = makeService({ g: ctx });

    const byAlice = await svc.start({ userId: 'alice', socketId: 's1', conversationId: 'g', type: 'video' });
    const denied = await svc.join({ userId: 'newbie', socketId: 's2', callId: byAlice.call!.id });
    expect(denied.error?.code).toBe('not_verified');
    await svc.leave({ userId: 'alice', callId: byAlice.call!.id });
    await svc.onEmptyGraceExpired(byAlice.call!.id);

    const byAdmin = await svc.start({ userId: 'admin', socketId: 's3', conversationId: 'g', type: 'video' });
    const ok = await svc.join({ userId: 'newbie', socketId: 's4', callId: byAdmin.call!.id });
    expect(ok.error).toBeUndefined();
    expect(ok.call?.participants.map((p) => p.userId).sort()).toEqual(['admin', 'newbie']);
  });
});

describe('CallsService direct call lifecycle', () => {
  it('rings the callee, records the timeline row, and schedules the ring timeout', async () => {
    const { svc, messages, realtime, jobs, sideEffects } = makeService({ [DIRECT.id]: DIRECT });
    const ack = await svc.start({ userId: 'alice', socketId: 's1', conversationId: DIRECT.id, type: 'video' });

    expect(ack.error).toBeUndefined();
    expect(ack.iceServers).toEqual([{ urls: ['stun:stun.example.com'] }]);
    expect(ack.reconnectGraceMs).toBe(30_000);
    expect(ack.call).toMatchObject({ status: 'ringing', capacity: 2, messageId: 'msg-1', startedByUserId: 'alice' });
    expect(ack.call?.participants).toHaveLength(1);
    expect(ack.call?.participants[0]?.cameraEnabled).toBe(true);

    expect(messages.createCallMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: DIRECT.id,
        senderId: 'alice',
        body: 'Started a video call',
        skipPushIfVoipRegistered: true,
      }),
    );
    expect(sideEffects.dispatch).toHaveBeenCalledWith('call.direct.ringing', {
      callId: ack.call!.id,
      conversationId: DIRECT.id,
      callerUserId: 'alice',
      calleeUserId: 'bob',
    });
    expect(realtime.emitCallsIncoming).toHaveBeenCalledWith('bob', expect.objectContaining({ call: expect.objectContaining({ id: ack.call!.id }) }));
    expect(realtime.emitCallsUpdated).toHaveBeenCalledWith(['alice', 'bob'], expect.objectContaining({ conversationId: DIRECT.id }));
    expect(jobs.enqueue).toHaveBeenCalledWith(
      'calls.ringTimeout',
      { callId: ack.call!.id },
      expect.objectContaining({ jobId: `call-ring-${ack.call!.id}`, delay: 40_000 }),
    );
  });

  it('accept → active, cancels the ring timer, edits the same row (no duplicate messages)', async () => {
    const { svc, messages, jobs } = makeService({ [DIRECT.id]: DIRECT });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: DIRECT.id, type: 'video' });
    const callId = started.call!.id;

    const joined = await svc.join({ userId: 'bob', socketId: 's2', callId });
    expect(joined.call?.status).toBe('active');
    expect(joined.reconnectGraceMs).toBe(30_000);
    expect(joined.call?.participants.map((p) => p.userId).sort()).toEqual(['alice', 'bob']);
    expect(joined.call?.participants.find((p) => p.userId === 'alice')?.cameraEnabled).toBe(true);
    expect(joined.call?.participants.find((p) => p.userId === 'bob')?.cameraEnabled).toBe(false);
    expect(jobs.removeById).toHaveBeenCalledWith('calls.ringTimeout', `call-ring-${callId}`);
    expect(messages.createCallMessage).toHaveBeenCalledTimes(1);
    expect(messages.updateCallMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-1', body: 'Video call in progress', call: expect.objectContaining({ outcome: 'active' }) }),
    );
  });

  it('ring timeout → missed call, session removed', async () => {
    const { svc, store, messages } = makeService({ [DIRECT.id]: DIRECT });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: DIRECT.id, type: 'audio' });
    await svc.onRingTimeout(started.call!.id);
    expect(store.byConversation.size).toBe(0);
    expect(messages.updateCallMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: 'Missed voice call', call: expect.objectContaining({ outcome: 'missed' }) }),
    );
    // Idempotent: a late-firing duplicate is a no-op.
    await svc.onRingTimeout(started.call!.id);
    expect(messages.updateCallMessage).toHaveBeenCalledTimes(1);
  });

  it('decline by the callee ends the call as declined; anyone else cannot decline', async () => {
    const { svc, messages } = makeService({ [DIRECT.id]: DIRECT });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: DIRECT.id, type: 'video' });
    const wrong = await svc.decline({ userId: 'alice', callId: started.call!.id });
    expect(wrong.error?.code).toBe('invalid_payload');
    const ok = await svc.decline({ userId: 'bob', callId: started.call!.id });
    expect(ok.call?.status).toBe('ended');
    expect(messages.updateCallMessage).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'Video call declined' }));
  });

  it('caller hanging up while ringing → cancelled', async () => {
    const { svc, messages } = makeService({ [DIRECT.id]: DIRECT });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: DIRECT.id, type: 'video' });
    const left = await svc.leave({ userId: 'alice', callId: started.call!.id });
    expect(left.call?.status).toBe('ended');
    expect(messages.updateCallMessage).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'Video call cancelled' }));
  });

  it('either side hanging up an active 1:1 call ends it for both (no empty grace)', async () => {
    const { svc, store, messages, jobs } = makeService({ [DIRECT.id]: DIRECT });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: DIRECT.id, type: 'video' });
    await svc.join({ userId: 'bob', socketId: 's2', callId: started.call!.id });

    const left = await svc.leave({ userId: 'alice', callId: started.call!.id });
    expect(left.call?.status).toBe('ended');
    expect(store.byConversation.size).toBe(0);
    expect(jobs.enqueue).not.toHaveBeenCalledWith('calls.emptyGrace', expect.anything(), expect.anything());
    expect(messages.updateCallMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ call: expect.objectContaining({ outcome: 'ended', peakParticipantCount: 2 }) }),
    );
  });

  it('a second start on the same conversation joins the existing call', async () => {
    const { svc } = makeService({ [DIRECT.id]: DIRECT });
    const a = await svc.start({ userId: 'alice', socketId: 's1', conversationId: DIRECT.id, type: 'video' });
    const b = await svc.start({ userId: 'bob', socketId: 's2', conversationId: DIRECT.id, type: 'video' });
    expect(b.call?.id).toBe(a.call!.id);
    expect(b.call?.status).toBe('active');
  });
});

describe('CallsService group calls and capacity', () => {
  it('starts active (no ring) and caps at 4 participants', async () => {
    const { svc, realtime, jobs, sideEffects, messages } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    expect(started.call?.status).toBe('active');
    expect(started.call?.capacity).toBe(4);
    expect(realtime.emitCallsIncoming).not.toHaveBeenCalled();
    // Groups don't ring: no VoIP push, and the ordinary DM alert stays on.
    expect(sideEffects.dispatch).not.toHaveBeenCalled();
    expect(messages.createCallMessage).toHaveBeenCalledWith(expect.objectContaining({ skipPushIfVoipRegistered: false }));
    expect(jobs.enqueue).not.toHaveBeenCalledWith('calls.ringTimeout', expect.anything(), expect.anything());

    const callId = started.call!.id;
    expect((await svc.join({ userId: 'bob', socketId: 's2', callId })).error).toBeUndefined();
    expect((await svc.join({ userId: 'carol', socketId: 's3', callId })).error).toBeUndefined();
    expect((await svc.join({ userId: 'dave', socketId: 's4', callId })).error).toBeUndefined();
    const full = await svc.join({ userId: 'erin', socketId: 's5', callId });
    expect(full.error?.code).toBe('call_full');

    // Someone leaves → a seat frees up.
    await svc.leave({ userId: 'dave', callId });
    expect((await svc.join({ userId: 'erin', socketId: 's5', callId })).error).toBeUndefined();
  });

  it('last leaver → empty grace, then ended with duration; rejoin during grace resumes', async () => {
    const { svc, jobs, messages, store } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'audio' });
    const callId = started.call!.id;

    const left = await svc.leave({ userId: 'alice', callId });
    expect(left.call?.status).toBe('empty');
    expect(jobs.enqueue).toHaveBeenCalledWith('calls.emptyGrace', { callId }, expect.objectContaining({ jobId: `call-empty-${callId}`, delay: 30_000 }));

    const back = await svc.join({ userId: 'bob', socketId: 's2', callId });
    expect(back.call?.status).toBe('active');
    expect(jobs.removeById).toHaveBeenCalledWith('calls.emptyGrace', `call-empty-${callId}`);
    // A stale grace job firing now must not end a live call.
    await svc.onEmptyGraceExpired(callId);
    expect(store.byConversation.size).toBe(1);

    await svc.leave({ userId: 'bob', callId });
    await svc.onEmptyGraceExpired(callId);
    expect(store.byConversation.size).toBe(0);
    expect(messages.updateCallMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        call: expect.objectContaining({ outcome: 'ended', durationSeconds: expect.any(Number), peakParticipantCount: 1 }),
      }),
    );
  });
});

describe('CallsService reconnect grace and multi-tab', () => {
  it('socket drop → reconnecting + grace job; rejoin from a new socket cancels it', async () => {
    const { svc, jobs, realtime } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    const callId = started.call!.id;
    await svc.join({ userId: 'bob', socketId: 's2', callId });

    await svc.markParticipantReconnecting({ userId: 'bob', callId, socketId: 's2' });
    const afterDrop = realtime.emitCallsUpdated.mock.calls.at(-1)![1].call;
    expect(afterDrop.participants.find((p: any) => p.userId === 'bob').connectionState).toBe('reconnecting');
    expect(jobs.enqueue).toHaveBeenCalledWith(
      'calls.participantGrace',
      { callId, userId: 'bob' },
      expect.objectContaining({ jobId: `call-pgrace-${callId}-bob`, delay: 30_000 }),
    );

    const rejoined = await svc.join({ userId: 'bob', socketId: 's3', callId });
    expect(rejoined.call?.participants.find((p) => p.userId === 'bob')?.connectionState).toBe('connected');
    expect(jobs.removeById).toHaveBeenCalledWith('calls.participantGrace', `call-pgrace-${callId}-bob`);

    // Grace firing after the rejoin must be a no-op.
    await svc.onParticipantGraceExpired(callId, 'bob');
    expect(realtime.emitCallsUpdated.mock.calls.at(-1)![1].call.participants).toHaveLength(2);
  });

  it('grace expiry removes a participant who never came back', async () => {
    const { svc, realtime } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    const callId = started.call!.id;
    await svc.join({ userId: 'bob', socketId: 's2', callId });
    await svc.markParticipantReconnecting({ userId: 'bob', callId, socketId: 's2' });
    await svc.onParticipantGraceExpired(callId, 'bob');
    expect(realtime.emitCallsUpdated.mock.calls.at(-1)![1].call.participants.map((p: any) => p.userId)).toEqual(['alice']);
  });

  it('a stale socket disconnect does not disturb a seat already taken by a newer socket', async () => {
    const { svc, jobs } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    await svc.markParticipantReconnecting({ userId: 'alice', callId: started.call!.id, socketId: 'old-socket' });
    expect(jobs.enqueue).not.toHaveBeenCalledWith('calls.participantGrace', expect.anything(), expect.anything());
  });

});

describe('CallsService liveness sweep', () => {
  const T0 = new Date('2026-01-01T00:00:00.000Z');
  const at = (ms: number) => new Date(T0.getTime() + ms);

  // Records stamp `startedAt` / `emptyAt` / `disconnectedAt` from the wall clock; pin it so the
  // sweep's explicit `now` is meaningful.
  beforeEach(() => jest.useFakeTimers({ now: T0 }));
  afterEach(() => jest.useRealTimers());

  it('leaves a healthy call alone', async () => {
    const { svc, liveSockets, store } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    await svc.join({ userId: 'bob', socketId: 's2', callId: started.call!.id });
    liveSockets.set('alice', new Set(['s1']));
    liveSockets.set('bob', new Set(['s2']));

    expect(await svc.sweepStaleSessions(at(60_000))).toBe(0);
    expect(store.byConversation.get(GROUP.id)!.participants.every((p) => p.connectionState === 'connected')).toBe(true);
  });

  it('a seat whose socket is gone (no disconnect event ever ran) enters reconnecting, then is removed after grace', async () => {
    const { svc, liveSockets, store, jobs } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    const callId = started.call!.id;
    await svc.join({ userId: 'bob', socketId: 's2', callId });
    liveSockets.set('alice', new Set(['s1']));
    // Bob's process died: presence has no proof his socket exists anymore.
    liveSockets.set('bob', new Set());

    expect(await svc.sweepStaleSessions(T0)).toBe(1);
    const bob = store.byConversation.get(GROUP.id)!.participants.find((p) => p.userId === 'bob')!;
    expect(bob.connectionState).toBe('reconnecting');
    expect(bob.socketId).toBeNull();
    expect(bob.disconnectedAt).toBe(T0.toISOString());
    expect(jobs.enqueue).toHaveBeenCalledWith('calls.participantGrace', { callId, userId: 'bob' }, expect.anything());

    // Within the grace window nothing more happens, even if the grace job was lost.
    expect(await svc.sweepStaleSessions(at(20_000))).toBe(0);
    // Past grace + slack the seat is released and the call goes on for alice.
    expect(await svc.sweepStaleSessions(at(40_000))).toBe(1);
    expect(store.byConversation.get(GROUP.id)!.participants.map((p) => p.userId)).toEqual(['alice']);
    expect(await store.getCallIdForUser('bob')).toBeNull();
  });

  it('when every participant is gone the call itself ends', async () => {
    const { svc, liveSockets, store, messages, realtime } = makeService({ [DIRECT.id]: DIRECT });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: DIRECT.id, type: 'audio' });
    const callId = started.call!.id;
    await svc.join({ userId: 'bob', socketId: 's2', callId });
    liveSockets.set('alice', new Set());
    liveSockets.set('bob', new Set());

    // First pass: both flagged reconnecting. Second pass after grace: first removal ends a 1:1 call.
    expect(await svc.sweepStaleSessions(T0)).toBe(2);
    const secondPass = await svc.sweepStaleSessions(at(40_000));
    expect(secondPass).toBeGreaterThanOrEqual(1);
    expect(store.byConversation.size).toBe(0);
    expect(store.live.size).toBe(0);
    expect(await store.getCallIdForUser('alice')).toBeNull();
    expect(await store.getCallIdForUser('bob')).toBeNull();
    expect(messages.updateCallMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ call: expect.objectContaining({ callId, outcome: 'ended' }) }),
    );
    expect(realtime.emitCallsUpdated.mock.calls.at(-1)![1].call.status).toBe('ended');
  });

  it('ends an empty call whose grace job never fired, and a ringing call nobody answered', async () => {
    const { svc, store, liveSockets } = makeService({ [GROUP.id]: GROUP, [DIRECT.id]: DIRECT });
    const group = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'audio' });
    await svc.leave({ userId: 'alice', callId: group.call!.id });
    expect(store.byConversation.get(GROUP.id)!.status).toBe('empty');

    const direct = await svc.start({ userId: 'bob', socketId: 's2', conversationId: DIRECT.id, type: 'audio' });
    liveSockets.set('bob', new Set(['s2']));
    expect(store.byConversation.get(DIRECT.id)!.status).toBe('ringing');

    // Too early for either deadline.
    expect(await svc.sweepStaleSessions(at(10_000))).toBe(0);
    expect(store.byConversation.size).toBe(2);

    // Empty grace (30s) + slack passed; ring timeout (40s) + slack not yet.
    expect(await svc.sweepStaleSessions(at(36_000))).toBe(1);
    expect(store.byConversation.has(GROUP.id)).toBe(false);
    expect(store.byConversation.get(DIRECT.id)!.status).toBe('ringing');

    expect(await svc.sweepStaleSessions(at(46_000))).toBe(1);
    expect(store.byConversation.has(DIRECT.id)).toBe(false);
    expect(direct.call!.id).toBeTruthy();
  });

  it('prunes live-index entries whose session is already gone', async () => {
    const { svc, store } = makeService({ [GROUP.id]: GROUP });
    store.live.add('conv-orphan');
    expect(await svc.sweepStaleSessions(T0)).toBe(0);
    expect(store.live.has('conv-orphan')).toBe(false);
  });
});

describe('CallsService one seat per member', () => {
  it('a newer tab joining the same call takes the seat and the displaced socket is told', async () => {
    const { svc, store, realtime } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    const callId = started.call!.id;
    const second = await svc.join({ userId: 'alice', socketId: 's2', callId });
    expect(second.error).toBeUndefined();
    expect(second.call?.participants).toHaveLength(1);
    expect(store.byConversation.get(GROUP.id)!.participants[0]!.socketId).toBe('s2');
    expect(realtime.emitCallsSeatTaken).toHaveBeenCalledWith('alice', { callId, socketId: 's1' });

    // The displaced tab can no longer hang up the call the new tab is in.
    const staleLeave = await svc.leave({ userId: 'alice', callId, socketId: 's1' });
    expect(staleLeave.call?.participants).toHaveLength(1);
    // Nor overwrite its mic/camera flags.
    await svc.updateParticipantState({ userId: 'alice', callId, socketId: 's1', micEnabled: false, screenSharing: true });
    expect(store.byConversation.get(GROUP.id)!.participants[0]!.micEnabled).toBe(true);
    expect(store.byConversation.get(GROUP.id)!.participants[0]!.screenSharing).toBeFalsy();

    const realLeave = await svc.leave({ userId: 'alice', callId, socketId: 's2' });
    expect(realLeave.call?.participants).toHaveLength(0);
  });

  it('records handRaised on the bound participant and surfaces it on the DTO', async () => {
    const { svc, store } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    const callId = started.call!.id;
    await svc.updateParticipantState({ userId: 'alice', callId, socketId: 's1', handRaised: true });
    expect(store.byConversation.get(GROUP.id)!.participants[0]!.handRaised).toBe(true);
    expect(CallSessionStore.toDto(store.byConversation.get(GROUP.id)!).participants[0]!.handRaised).toBe(true);
  });

  it('clears raised hands when a group call drops to two people', async () => {
    const { svc, store } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'audio' });
    const callId = started.call!.id;
    await svc.join({ userId: 'bob', socketId: 's2', callId });
    await svc.join({ userId: 'carol', socketId: 's3', callId });
    await svc.updateParticipantState({ userId: 'alice', callId, socketId: 's1', handRaised: true });
    await svc.updateParticipantState({ userId: 'bob', callId, socketId: 's2', handRaised: true });
    expect(store.byConversation.get(GROUP.id)!.participants).toHaveLength(3);
    await svc.leave({ userId: 'carol', callId, socketId: 's3' });
    const left = store.byConversation.get(GROUP.id)!.participants;
    expect(left).toHaveLength(2);
    expect(left.every((p) => !p.handRaised)).toBe(true);
    expect(CallSessionStore.toDto(store.byConversation.get(GROUP.id)!).participants.every((p) => !p.handRaised)).toBe(true);
  });

  it('records screenSharing on the bound participant and surfaces it on the DTO', async () => {
    const { svc, store } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    const callId = started.call!.id;
    await svc.updateParticipantState({ userId: 'alice', callId, socketId: 's1', screenSharing: true });
    expect(store.byConversation.get(GROUP.id)!.participants[0]!.screenSharing).toBe(true);
    const dto = store.byConversation.get(GROUP.id)!;
    expect(CallSessionStore.toDto(dto).participants[0]!.screenSharing).toBe(true);
  });

  it('keeps only one presenter when a second participant starts sharing', async () => {
    const { svc, store } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    const callId = started.call!.id;
    await svc.join({ userId: 'bob', socketId: 's2', callId });
    await svc.updateParticipantState({ userId: 'alice', callId, socketId: 's1', screenSharing: true });
    await svc.updateParticipantState({ userId: 'bob', callId, socketId: 's2', screenSharing: true });
    const parts = store.byConversation.get(GROUP.id)!.participants;
    expect(parts.find((p) => p.userId === 'alice')!.screenSharing).toBe(true);
    expect(parts.find((p) => p.userId === 'bob')!.screenSharing).toBeFalsy();
  });

  it('rejoining from the same socket is not a takeover', async () => {
    const { svc, realtime } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    await svc.join({ userId: 'alice', socketId: 's1', callId: started.call!.id });
    expect(realtime.emitCallsSeatTaken).not.toHaveBeenCalled();
  });

  it('joining a different call removes the member from the one they were in', async () => {
    const OTHER: CallConversationContext = {
      id: 'conv-other',
      type: 'group',
      participants: [member('alice'), member('zoe'), member('yan')],
      relationship: null,
    };
    const { svc, store, realtime } = makeService({ [GROUP.id]: GROUP, [OTHER.id]: OTHER });
    const first = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    await svc.join({ userId: 'bob', socketId: 's2', callId: first.call!.id });
    expect(await store.getCallIdForUser('alice')).toBe(first.call!.id);

    const second = await svc.start({ userId: 'alice', socketId: 's3', conversationId: OTHER.id, type: 'audio' });
    expect(second.error).toBeUndefined();
    expect(await store.getCallIdForUser('alice')).toBe(second.call!.id);
    // The first call carries on without her; her old tab sees itself gone from `participants`.
    expect(store.byConversation.get(GROUP.id)!.participants.map((p) => p.userId)).toEqual(['bob']);
    const updatesForFirst = realtime.emitCallsUpdated.mock.calls.filter((c) => c[1].call.id === first.call!.id);
    expect(updatesForFirst.at(-1)![1].call.participants.map((p: any) => p.userId)).toEqual(['bob']);
  });

  it('starting a second call while in a 1:1 hangs the 1:1 up for both', async () => {
    const { svc, store, messages } = makeService({ [DIRECT.id]: DIRECT, [GROUP.id]: GROUP });
    const dm = await svc.start({ userId: 'alice', socketId: 's1', conversationId: DIRECT.id, type: 'audio' });
    await svc.join({ userId: 'bob', socketId: 's2', callId: dm.call!.id });

    await svc.start({ userId: 'alice', socketId: 's3', conversationId: GROUP.id, type: 'audio' });
    expect(store.byConversation.has(DIRECT.id)).toBe(false);
    expect(messages.updateCallMessage).toHaveBeenLastCalledWith(expect.objectContaining({ call: expect.objectContaining({ outcome: 'ended' }) }));
    expect(await store.getCallIdForUser('bob')).toBeNull();
  });

  it('publishes the in-call flag for presence on seat changes only', async () => {
    const { svc, realtime } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    const callId = started.call!.id;
    expect(realtime.emitPresenceCallChanged).toHaveBeenCalledWith('alice', { userId: 'alice', inCall: true });

    await svc.join({ userId: 'bob', socketId: 's2', callId });
    expect(realtime.emitPresenceCallChanged).toHaveBeenCalledWith('bob', { userId: 'bob', inCall: true });
    realtime.emitPresenceCallChanged.mockClear();

    // Reconnect + rejoin and a same-user takeover don't change the flag.
    await svc.markParticipantReconnecting({ userId: 'bob', callId, socketId: 's2' });
    await svc.join({ userId: 'bob', socketId: 's3', callId });
    await svc.join({ userId: 'alice', socketId: 's4', callId });
    expect(realtime.emitPresenceCallChanged).not.toHaveBeenCalled();

    await svc.leave({ userId: 'bob', callId, socketId: 's3' });
    expect(realtime.emitPresenceCallChanged).toHaveBeenCalledWith('bob', { userId: 'bob', inCall: false });
    // A no-op leave (already gone) is silent.
    realtime.emitPresenceCallChanged.mockClear();
    await svc.leave({ userId: 'bob', callId, socketId: 's3' });
    expect(realtime.emitPresenceCallChanged).not.toHaveBeenCalled();

    // Ending the call clears everyone still seated.
    await svc.leave({ userId: 'alice', callId, socketId: 's4' });
    await svc.onEmptyGraceExpired(callId);
    expect(realtime.emitPresenceCallChanged).toHaveBeenCalledWith('alice', { userId: 'alice', inCall: false });
  });
});

describe('CallsService signaling relay', () => {
  it('relays only between two current participants and strips unknown fields', async () => {
    const { svc, realtime } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    const callId = started.call!.id;
    await svc.join({ userId: 'bob', socketId: 's2', callId });

    await svc.relaySignal({ fromUserId: 'alice', callId, toUserId: 'carol', description: { type: 'offer', sdp: 'v=0' } });
    expect(realtime.emitRtcSignal).not.toHaveBeenCalled();

    await svc.relaySignal({ fromUserId: 'carol', callId, toUserId: 'alice', description: { type: 'offer', sdp: 'v=0' } });
    expect(realtime.emitRtcSignal).not.toHaveBeenCalled();

    await svc.relaySignal({
      fromUserId: 'alice',
      callId,
      toUserId: 'bob',
      description: { type: 'offer', sdp: 'v=0', evil: 'x' },
    });
    expect(realtime.emitRtcSignal).toHaveBeenCalledWith('bob', { callId, fromUserId: 'alice', description: { type: 'offer', sdp: 'v=0' } });

    await svc.relaySignal({
      fromUserId: 'bob',
      callId,
      toUserId: 'alice',
      candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    expect(realtime.emitRtcSignal).toHaveBeenLastCalledWith('alice', {
      callId,
      fromUserId: 'bob',
      candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
  });

  it('drops malformed descriptions', async () => {
    const { svc, realtime } = makeService({ [DIRECT.id]: DIRECT });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: DIRECT.id, type: 'video' });
    await svc.join({ userId: 'bob', socketId: 's2', callId: started.call!.id });
    await svc.relaySignal({ fromUserId: 'alice', callId: started.call!.id, toUserId: 'bob', description: { type: 'bogus' } });
    await svc.relaySignal({ fromUserId: 'alice', callId: started.call!.id, toUserId: 'bob', candidate: { sdpMid: '0' } });
    expect(realtime.emitRtcSignal).not.toHaveBeenCalled();
  });
});

describe('call message copy', () => {
  it('formats durations for humans', () => {
    expect(formatCallDuration(12)).toBe('< 1 min');
    expect(formatCallDuration(60 * 42)).toBe('42 min');
    expect(formatCallDuration(60 * 65)).toBe('1 hr 5 min');
    expect(formatCallDuration(3600 * 2)).toBe('2 hr');
  });

  it('keeps every body readable as plain text for older clients', () => {
    expect(callMessageBody('video', 'ended', 2520)).toBe('Video call ended · 42 min');
    expect(callMessageBody('audio', 'missed', null)).toBe('Missed voice call');
    expect(callMessageBody('audio', 'started', null)).toBe('Started a voice call');
  });
});
