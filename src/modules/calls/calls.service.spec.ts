import { NotFoundException } from '@nestjs/common';
import { CallsService, callMessageBody, formatCallDuration } from './calls.service';
import { CallSessionStore, type CallSessionRecord } from './call-session.store';
import type { CallConversationContext } from '../messages/messages.service';

// ─── In-memory stand-in for the Redis-backed store ───────────────────────────

class FakeStore {
  readonly byConversation = new Map<string, CallSessionRecord>();

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
  async save(r: CallSessionRecord) {
    this.byConversation.set(r.conversationId, structuredClone(r));
  }
  async delete(r: { id: string; conversationId: string }) {
    this.byConversation.delete(r.conversationId);
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
    premium: true,
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
  };
  const jobs = {
    enqueue: jest.fn(async () => ({})),
    removeById: jest.fn(async () => undefined),
  };
  const appConfig = { rtcIceServers: jest.fn(() => [{ urls: ['stun:stun.example.com'] }]) };
  const svc = new CallsService(store as unknown as CallSessionStore, messages as any, realtime as any, jobs as any, appConfig as any);
  return { svc, store, messages, realtime, jobs };
}

const DIRECT: CallConversationContext = {
  id: 'conv-direct',
  type: 'direct',
  participants: [member('alice'), member('bob')],
};

const GROUP: CallConversationContext = {
  id: 'conv-group',
  type: 'group',
  participants: [member('alice'), member('bob'), member('carol'), member('dave'), member('erin')],
};

afterEach(() => jest.restoreAllMocks());

describe('CallsService gating', () => {
  it('rejects a starter who is neither admin nor premium+verified', async () => {
    const { svc } = makeService({
      c: { id: 'c', type: 'direct', participants: [member('alice', { premium: false }), member('bob')] },
    });
    const ack = await svc.start({ userId: 'alice', socketId: 's1', conversationId: 'c', type: 'video' });
    expect(ack.error?.code).toBe('not_allowed_to_start');
    expect(ack.call).toBeNull();
  });

  it('rejects calling an unverified member unless the caller is an admin', async () => {
    const { svc } = makeService({
      c: { id: 'c', type: 'direct', participants: [member('alice'), member('bob', { verified: false })] },
      a: { id: 'a', type: 'direct', participants: [member('admin', { siteAdmin: true, premium: false }), member('bob', { verified: false })] },
    });
    const denied = await svc.start({ userId: 'alice', socketId: 's1', conversationId: 'c', type: 'audio' });
    expect(denied.error?.code).toBe('callee_not_verified');

    const allowed = await svc.start({ userId: 'admin', socketId: 's2', conversationId: 'a', type: 'audio' });
    expect(allowed.error).toBeUndefined();
    expect(allowed.call?.startedByAdmin).toBe(true);
  });

  it('rejects non-members and bots', async () => {
    const { svc } = makeService({
      c: { id: 'c', type: 'direct', participants: [member('alice'), member('marv', { isBot: true })] },
    });
    expect((await svc.start({ userId: 'zed', socketId: 's', conversationId: 'c', type: 'video' })).error?.code).toBe('not_member');
    expect((await svc.start({ userId: 'alice', socketId: 's', conversationId: 'c', type: 'video' })).error?.code).toBe('callee_unavailable');
  });

  it('lets an unverified member join only when an admin started the call', async () => {
    const ctx: CallConversationContext = {
      id: 'g',
      type: 'group',
      participants: [member('admin', { siteAdmin: true }), member('alice'), member('newbie', { verified: false, premium: false })],
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
    const { svc, messages, realtime, jobs } = makeService({ [DIRECT.id]: DIRECT });
    const ack = await svc.start({ userId: 'alice', socketId: 's1', conversationId: DIRECT.id, type: 'video' });

    expect(ack.error).toBeUndefined();
    expect(ack.iceServers).toEqual([{ urls: ['stun:stun.example.com'] }]);
    expect(ack.call).toMatchObject({ status: 'ringing', capacity: 2, messageId: 'msg-1', startedByUserId: 'alice' });
    expect(ack.call?.participants).toHaveLength(1);

    expect(messages.createCallMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: DIRECT.id, senderId: 'alice', body: 'Started a video call' }),
    );
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
    expect(joined.call?.participants.map((p) => p.userId).sort()).toEqual(['alice', 'bob']);
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
    const { svc, realtime, jobs } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    expect(started.call?.status).toBe('active');
    expect(started.call?.capacity).toBe(4);
    expect(realtime.emitCallsIncoming).not.toHaveBeenCalled();
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
      expect.objectContaining({ jobId: `call-pgrace-${callId}-bob`, delay: 20_000 }),
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

  it('a second tab cannot join while the first is still connected', async () => {
    const { svc } = makeService({ [GROUP.id]: GROUP });
    const started = await svc.start({ userId: 'alice', socketId: 's1', conversationId: GROUP.id, type: 'video' });
    const second = await svc.join({ userId: 'alice', socketId: 's2', callId: started.call!.id });
    expect(second.error?.code).toBe('already_in_call');
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
