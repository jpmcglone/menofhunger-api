import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'node:crypto';
import type {
  CallsAckDto,
  CallsAckErrorCode,
  CallType,
  MessageCallDto,
  MessageCallOutcome,
  RtcIceCandidateDto,
  RtcIceServerDto,
  RtcSessionDescriptionDto,
} from '../../common/dto/call.dto';
import type { UserListDto } from '../../common/dto/user.dto';
import { RtcIceServersService } from './rtc-ice-servers.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS, type JobName } from '../jobs/jobs.constants';
import { MessagesService, type CallConversationContext } from '../messages/messages.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PresenceRedisStateService } from '../presence/presence-redis-state.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { CallSessionStore, type CallParticipantRecord, type CallSessionRecord } from './call-session.store';
import {
  CALL_EMPTY_GRACE_MS,
  CALL_PARTICIPANT_GRACE_MS,
  CALL_RING_TIMEOUT_MS,
  CALL_SWEEP_SLACK_MS,
  callCapacityFor,
  callEmptyGraceJobId,
  callParticipantGraceJobId,
  callRingTimeoutJobId,
} from './calls.constants';

const MAX_SDP_BYTES = 200_000;

function ackError(code: CallsAckErrorCode, message: string): CallsAckDto {
  return { call: null, error: { code, message } };
}

function callLabel(type: CallType): string {
  return type === 'video' ? 'video call' : 'voice call';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatCallDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return '< 1 min';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h} hr ${rem} min` : `${h} hr`;
}

/** Human-readable body for the `kind: 'call'` row. Older clients render this as plain text. */
export function callMessageBody(type: CallType, outcome: MessageCallOutcome, durationSeconds: number | null): string {
  const label = callLabel(type);
  switch (outcome) {
    case 'started':
      return `Started a ${label}`;
    case 'active':
      return `${capitalize(label)} in progress`;
    case 'ended':
      return durationSeconds != null ? `${capitalize(label)} ended · ${formatCallDuration(durationSeconds)}` : `${capitalize(label)} ended`;
    case 'missed':
      return `Missed ${label}`;
    case 'declined':
      return `${capitalize(label)} declined`;
    case 'cancelled':
      return `${capitalize(label)} cancelled`;
  }
}

/**
 * DM voice/video call lifecycle. Owns the ephemeral Redis session, authorization, the
 * timeline row, and the timers. Never touches media: browsers negotiate directly and
 * this service only relays SDP/ICE between two current participants.
 */
@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly store: CallSessionStore,
    private readonly messages: MessagesService,
    private readonly realtime: PresenceRealtimeService,
    private readonly jobs: JobsService,
    private readonly iceServers: RtcIceServersService,
    private readonly sideEffects: SideEffectsService,
    private readonly presenceRedis: PresenceRedisStateService,
  ) {}

  /** Fields every successful start/join ack carries so a client can connect and knows when to stop retrying. */
  private connectAck(record: CallSessionRecord, iceServers: RtcIceServerDto[]): CallsAckDto {
    return { call: CallSessionStore.toDto(record), iceServers, reconnectGraceMs: CALL_PARTICIPANT_GRACE_MS };
  }

  // ─── Lifecycle (client-initiated) ────────────────────────────────────────────

  async start(params: { userId: string; socketId: string; conversationId: string; type: CallType }): Promise<CallsAckDto> {
    const { userId, socketId, conversationId, type } = params;
    const iceServersPromise = this.iceServers.resolve();
    let ctx: CallConversationContext;
    try {
      ctx = await this.messages.getCallConversationContext({ userId, conversationId });
    } catch (err) {
      if (err instanceof NotFoundException) return ackError('not_member', 'Conversation not found.');
      throw err;
    }
    const viewer = ctx.participants.find((p) => p.userId === userId);
    if (!viewer || viewer.banned) return ackError('not_member', 'Conversation not found.');
    if (viewer.status !== 'accepted') {
      return ackError('conversation_not_accepted', 'Accept this conversation before starting a call.');
    }

    // One live session per conversation: a second "start" is just a join.
    const existing = await this.store.getByConversationId(conversationId);
    if (existing && existing.status !== 'ended') {
      return await this.join({ userId, socketId, callId: existing.id });
    }

    // One seat per member: starting here hangs up whatever they were in elsewhere.
    await this.leaveOtherCall(userId, null);

    // Verified members call; admins call anybody. Group chats are a relationship by definition.
    // For a DM the other side must have accepted the thread, follow us back, or share a group
    // chat with us — one is enough.
    if (!viewer.siteAdmin && !viewer.verified) return ackError('not_allowed_to_start', 'Calls are for verified members.');

    let ringTargetUserId: string | null = null;
    if (ctx.type === 'direct') {
      const callee = ctx.participants.find((p) => p.userId !== userId) ?? null;
      if (!callee || callee.isBot || callee.banned) return ackError('callee_unavailable', "You can't call this account.");
      if (!viewer.siteAdmin) {
        if (!callee.verified) return ackError('callee_not_verified', 'You can only call verified members.');
        const related =
          callee.status === 'accepted' || Boolean(ctx.relationship?.mutualFollow) || Boolean(ctx.relationship?.sharedGroupConversation);
        if (!related) {
          return ackError(
            'conversation_not_accepted',
            'They need to accept your message, follow you back, or share a group chat with you first.',
          );
        }
      }
      ringTargetUserId = callee.userId;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const isDirect = ctx.type === 'direct';
    const record: CallSessionRecord = {
      id: crypto.randomUUID(),
      conversationId,
      conversationType: ctx.type,
      type,
      status: isDirect ? 'ringing' : 'active',
      startedByUserId: userId,
      startedByAdmin: viewer.siteAdmin,
      startedAt: nowIso,
      activeAt: isDirect ? null : nowIso,
      emptyAt: null,
      endedAt: null,
      capacity: callCapacityFor(ctx.type),
      messageId: null,
      ringTargetUserId,
      peakParticipantCount: 1,
      participants: [this.newParticipant(userId, socketId, type, nowIso)],
    };

    const created = await this.store.withConversationLock(conversationId, async () => {
      const raced = await this.store.getByConversationId(conversationId);
      if (raced && raced.status !== 'ended') return raced;
      await this.store.save(record);
      return record;
    });
    if (created.id !== record.id) {
      return await this.join({ userId, socketId, callId: created.id });
    }

    const outcome: MessageCallOutcome = isDirect ? 'started' : 'active';
    let callerDto: UserListDto | null = null;
    try {
      const message = await this.messages.createCallMessage({
        conversationId,
        senderId: userId,
        body: callMessageBody(type, 'started', null),
        call: this.toMessageCall(record, outcome, null),
        // A direct ring reaches iPhones through PushKit/CallKit; the DM alert would be a duplicate there.
        skipPushIfVoipRegistered: isDirect,
      });
      record.messageId = message.id;
      callerDto = message.sender;
      await this.store.save(record);
    } catch (err) {
      this.logger.warn(`[calls] failed to create call message call=${record.id}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const memberIds = ctx.participants.map((p) => p.userId);
    this.emitUpdated(memberIds, record);
    this.realtime.emitPresenceCallChanged(userId, { userId, inCall: true });
    if (isDirect && ringTargetUserId && callerDto) {
      this.realtime.emitCallsIncoming(ringTargetUserId, { call: CallSessionStore.toDto(record), caller: callerDto });
      await this.enqueueTimer(JOBS.callRingTimeout, callRingTimeoutJobId(record.id), { callId: record.id }, CALL_RING_TIMEOUT_MS);
      this.sideEffects.dispatch('call.direct.ringing', {
        callId: record.id,
        conversationId,
        callerUserId: userId,
        calleeUserId: ringTargetUserId,
      });
    }

    return this.connectAck(record, await iceServersPromise);
  }

  async join(params: { userId: string; socketId: string; callId: string }): Promise<CallsAckDto> {
    const { userId, socketId, callId } = params;
    const initial = await this.store.getByCallId(callId);
    if (!initial) return ackError('call_not_found', 'This call has ended.');

    let ctx: CallConversationContext;
    try {
      ctx = await this.messages.getCallConversationContext({ userId, conversationId: initial.conversationId });
    } catch (err) {
      if (err instanceof NotFoundException) return ackError('not_member', 'Conversation not found.');
      throw err;
    }
    const viewer = ctx.participants.find((p) => p.userId === userId);
    if (!viewer || viewer.banned) return ackError('not_member', 'Conversation not found.');
    if (viewer.status !== 'accepted') {
      return ackError('conversation_not_accepted', 'Accept this conversation before joining a call.');
    }
    if (!viewer.verified && !viewer.siteAdmin && !initial.startedByAdmin) {
      return ackError('not_verified', 'Verify your account to join calls.');
    }

    // One seat per member: joining here hangs up whatever they were in elsewhere.
    await this.leaveOtherCall(userId, callId);

    type JoinResult = {
      ack: CallsAckDto;
      record: CallSessionRecord | null;
      becameActiveFromRinging: boolean;
      cancel: string[];
      /** Same call, different tab/device: the socket that held the seat until now. */
      displacedSocketId: string | null;
      newlySeated: boolean;
    };
    const fail = (ack: CallsAckDto): JoinResult => ({
      ack,
      record: null,
      becameActiveFromRinging: false,
      cancel: [],
      displacedSocketId: null,
      newlySeated: false,
    });
    const iceServers = await this.iceServers.resolve();
    const result = await this.store.withConversationLock(initial.conversationId, async (): Promise<JoinResult> => {
      const record = await this.store.getByConversationId(initial.conversationId);
      if (!record || record.id !== callId || record.status === 'ended') {
        return fail(ackError('call_ended', 'This call has ended.'));
      }
      const nowIso = new Date().toISOString();
      const cancel: string[] = [];
      let displacedSocketId: string | null = null;
      let newlySeated = false;
      const existing = record.participants.find((p) => p.userId === userId);
      if (existing) {
        // The newest tab/device wins the seat; the previous one is told to stand down.
        if (existing.connectionState === 'connected' && existing.socketId && existing.socketId !== socketId) {
          displacedSocketId = existing.socketId;
        }
        existing.socketId = socketId;
        existing.connectionState = 'connected';
        existing.disconnectedAt = null;
        cancel.push(callParticipantGraceJobId(record.id, userId));
      } else {
        if (record.participants.length >= record.capacity) {
          return fail(ackError('call_full', 'This call is full.'));
        }
        record.participants.push(this.newParticipant(userId, socketId, record.type, nowIso));
        newlySeated = true;
      }

      let becameActiveFromRinging = false;
      if (record.status === 'ringing') {
        record.status = 'active';
        record.activeAt = record.activeAt ?? nowIso;
        becameActiveFromRinging = true;
        cancel.push(callRingTimeoutJobId(record.id));
      } else if (record.status === 'empty') {
        record.status = 'active';
        record.emptyAt = null;
        cancel.push(callEmptyGraceJobId(record.id));
      }
      record.peakParticipantCount = Math.max(record.peakParticipantCount, record.participants.length);
      await this.store.save(record);
      return { ack: this.connectAck(record, iceServers), record, becameActiveFromRinging, cancel, displacedSocketId, newlySeated };
    });

    if (!result.record) return result.ack;
    for (const jobId of result.cancel) await this.cancelTimer(jobId);
    if (result.becameActiveFromRinging && result.record.messageId) {
      await this.safeUpdateMessage(result.record, 'active', null);
    }
    if (result.displacedSocketId) {
      this.realtime.emitCallsSeatTaken(userId, { callId, socketId: result.displacedSocketId });
    }
    if (result.newlySeated) this.realtime.emitPresenceCallChanged(userId, { userId, inCall: true });
    this.emitUpdated(ctx.participants.map((p) => p.userId), result.record);
    return result.ack;
  }

  /**
   * Only the socket that holds the seat may give it up. A tab that was displaced by a newer
   * one must not be able to hang up the call the newcomer is now in.
   */
  async leave(params: { userId: string; callId: string; socketId?: string }): Promise<CallsAckDto> {
    const { userId, callId, socketId } = params;
    const record = await this.store.getByCallId(callId);
    if (!record) return { call: null };
    const seat = record.participants.find((p) => p.userId === userId);
    if (seat && socketId && seat.socketId && seat.socketId !== socketId) {
      return { call: CallSessionStore.toDto(record) };
    }
    const updated = await this.removeParticipant(record.conversationId, callId, userId);
    return { call: updated ? CallSessionStore.toDto(updated) : null };
  }

  /**
   * One seat per member across tabs and devices. If `userId` currently sits in a call other
   * than `keepCallId`, remove them from it (which, for a 1:1, ends that call) before they
   * take a seat in the new one. The old tab learns via `calls:updated` that it's no longer
   * a participant and tears down.
   */
  private async leaveOtherCall(userId: string, keepCallId: string | null): Promise<void> {
    const heldCallId = await this.store.getCallIdForUser(userId);
    if (!heldCallId || heldCallId === keepCallId) return;
    const held = await this.store.getByCallId(heldCallId);
    if (!held) return;
    await this.removeParticipant(held.conversationId, heldCallId, userId);
  }

  /** Direct calls only: the rung callee refuses. */
  async decline(params: { userId: string; callId: string }): Promise<CallsAckDto> {
    const { userId, callId } = params;
    const record = await this.store.getByCallId(callId);
    if (!record) return { call: null };
    if (record.status !== 'ringing' || record.ringTargetUserId !== userId) {
      return ackError('invalid_payload', 'This call can no longer be declined.');
    }
    const ended = await this.endCall(record.conversationId, callId, 'declined');
    return { call: ended ? CallSessionStore.toDto(ended) : null };
  }

  async updateParticipantState(params: {
    userId: string;
    callId: string;
    socketId?: string;
    micEnabled?: boolean;
    cameraEnabled?: boolean;
    screenSharing?: boolean;
    handRaised?: boolean;
  }): Promise<void> {
    const { userId, callId, socketId } = params;
    const initial = await this.store.getByCallId(callId);
    if (!initial) return;
    const record = await this.store.withConversationLock(initial.conversationId, async () => {
      const rec = await this.store.getByConversationId(initial.conversationId);
      if (!rec || rec.id !== callId) return null;
      const p = rec.participants.find((x) => x.userId === userId);
      if (!p) return null;
      // A displaced tab's late mic/camera flags must not overwrite the seat holder's.
      if (socketId && p.socketId && p.socketId !== socketId) return null;
      if (typeof params.micEnabled === 'boolean') p.micEnabled = params.micEnabled;
      if (typeof params.cameraEnabled === 'boolean') p.cameraEnabled = params.cameraEnabled;
      if (typeof params.screenSharing === 'boolean') p.screenSharing = params.screenSharing;
      if (typeof params.handRaised === 'boolean') p.handRaised = params.handRaised;
      await this.store.save(rec);
      return rec;
    });
    if (!record) return;
    await this.emitUpdatedToConversation(record);
  }

  /**
   * Relay SDP / ICE. Both ends must be current participants of the same call, so knowing
   * a call id is never enough to push signaling into someone's browser.
   */
  async relaySignal(params: {
    fromUserId: string;
    callId: string;
    toUserId: string;
    description?: unknown;
    candidate?: unknown;
  }): Promise<void> {
    const { fromUserId, callId, toUserId } = params;
    if (!toUserId || toUserId === fromUserId) return;
    const record = await this.store.getByCallId(callId);
    if (!record || record.status === 'ended') return;
    const isParticipant = (uid: string) => record.participants.some((p) => p.userId === uid);
    if (!isParticipant(fromUserId) || !isParticipant(toUserId)) return;

    const description = this.sanitizeDescription(params.description);
    const candidate = this.sanitizeCandidate(params.candidate);
    if (!description && !candidate) return;
    this.realtime.emitRtcSignal(toUserId, {
      callId,
      fromUserId,
      ...(description ? { description } : {}),
      ...(candidate ? { candidate } : {}),
    });
  }

  /** The socket bound to a participant dropped. Hold the seat for a grace period. */
  async markParticipantReconnecting(params: { userId: string; callId: string; socketId: string | null }): Promise<void> {
    const { userId, callId, socketId } = params;
    const initial = await this.store.getByCallId(callId);
    if (!initial) return;
    const record = await this.store.withConversationLock(initial.conversationId, async () => {
      const rec = await this.store.getByConversationId(initial.conversationId);
      if (!rec || rec.id !== callId) return null;
      const p = rec.participants.find((x) => x.userId === userId);
      // A newer tab already took the seat; the stale socket has nothing to release.
      if (!p || p.socketId !== socketId || p.connectionState !== 'connected') return null;
      p.connectionState = 'reconnecting';
      p.socketId = null;
      p.disconnectedAt = new Date().toISOString();
      await this.store.save(rec);
      return rec;
    });
    if (!record) return;
    await this.enqueueTimer(
      JOBS.callParticipantGrace,
      callParticipantGraceJobId(callId, userId),
      { callId, userId },
      CALL_PARTICIPANT_GRACE_MS,
    );
    await this.emitUpdatedToConversation(record);
  }

  // ─── Timers (fired by the background worker; all idempotent, all re-read Redis) ──

  async onRingTimeout(callId: string): Promise<void> {
    const record = await this.store.getByCallId(callId);
    if (!record || record.status !== 'ringing') return;
    await this.endCall(record.conversationId, callId, 'missed');
  }

  async onEmptyGraceExpired(callId: string): Promise<void> {
    const record = await this.store.getByCallId(callId);
    if (!record || record.status !== 'empty' || record.participants.length > 0) return;
    await this.endCall(record.conversationId, callId, 'ended');
  }

  async onParticipantGraceExpired(callId: string, userId: string): Promise<void> {
    const record = await this.store.getByCallId(callId);
    if (!record) return;
    const p = record.participants.find((x) => x.userId === userId);
    if (!p || p.connectionState !== 'reconnecting') return;
    await this.removeParticipant(record.conversationId, callId, userId);
  }

  // ─── Liveness sweep (periodic backstop for everything above) ──────────────────

  /**
   * Re-derive every live session's truth from what Redis can prove, so a call never outlives
   * its participants. The event-driven paths above are primary; this catches what they miss:
   * a disconnect on an API process that died before `handleDisconnect` ran (deploys,
   * `--watch` restarts), a lost/never-consumed delayed job, or a seat left `connected` by
   * any other gap. Idempotent and safe to run on every instance.
   *
   * Returns the number of corrective actions taken (for tests and logs).
   */
  async sweepStaleSessions(now: Date = new Date()): Promise<number> {
    const conversationIds = await this.store.listLiveConversationIds();
    let actions = 0;
    for (const conversationId of conversationIds) {
      try {
        actions += await this.sweepConversation(conversationId, now);
      } catch (err) {
        this.logger.warn(`[calls] sweep failed conv=${conversationId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return actions;
  }

  private async sweepConversation(conversationId: string, now: Date): Promise<number> {
    const record = await this.store.getByConversationId(conversationId);
    if (!record) {
      await this.store.forgetLiveConversation(conversationId);
      return 0;
    }
    const nowMs = now.getTime();
    const ageOf = (iso: string | null | undefined): number => (iso ? nowMs - new Date(iso).getTime() : Number.POSITIVE_INFINITY);

    if (record.status === 'ringing' && ageOf(record.startedAt) > CALL_RING_TIMEOUT_MS + CALL_SWEEP_SLACK_MS) {
      await this.endCall(conversationId, record.id, 'missed');
      return 1;
    }
    if (record.status === 'empty') {
      if (ageOf(record.emptyAt) <= CALL_EMPTY_GRACE_MS + CALL_SWEEP_SLACK_MS) return 0;
      await this.endCall(conversationId, record.id, 'ended');
      return 1;
    }
    if (record.status === 'active' && record.participants.length === 0) {
      // Should be unreachable (removeParticipant flips to `empty`), but never leave a seatless active call.
      await this.endCall(conversationId, record.id, 'ended');
      return 1;
    }

    let actions = 0;
    for (const p of record.participants) {
      if (p.connectionState === 'connected') {
        const live = p.socketId ? await this.presenceRedis.liveSocketIdsForUser(p.userId) : new Set<string>();
        if (p.socketId && live.has(p.socketId)) continue;
        await this.markParticipantReconnecting({ userId: p.userId, callId: record.id, socketId: p.socketId });
        actions += 1;
        continue;
      }
      if (p.connectionState === 'reconnecting' && ageOf(p.disconnectedAt ?? p.joinedAt) > CALL_PARTICIPANT_GRACE_MS + CALL_SWEEP_SLACK_MS) {
        await this.removeParticipant(conversationId, record.id, p.userId);
        actions += 1;
      }
    }
    return actions;
  }

  // ─── Internals ────────────────────────────────────────────────────────────────

  private newParticipant(userId: string, socketId: string, type: CallType, joinedAt: string): CallParticipantRecord {
    return { userId, joinedAt, micEnabled: true, cameraEnabled: type === 'video', connectionState: 'connected', socketId };
  }

  /**
   * Remove one participant. Empty ringing call → cancelled; empty active call → `empty`
   * with a grace timer; otherwise everyone else stays connected (no host).
   */
  private async removeParticipant(conversationId: string, callId: string, userId: string): Promise<CallSessionRecord | null> {
    type Outcome = { record: CallSessionRecord | null; removed: boolean; endAs: MessageCallOutcome | null; scheduleEmpty: boolean };
    const outcome = await this.store.withConversationLock(conversationId, async (): Promise<Outcome> => {
      const rec = await this.store.getByConversationId(conversationId);
      if (!rec || rec.id !== callId) return { record: null, removed: false, endAs: null, scheduleEmpty: false };
      const before = rec.participants.length;
      rec.participants = rec.participants.filter((p) => p.userId !== userId);
      if (rec.participants.length === before) return { record: rec, removed: false, endAs: null, scheduleEmpty: false };
      // A 1:1 call has nobody else who could join, so either side leaving hangs up for both.
      // Group calls stay open for the remaining members.
      if (rec.conversationType === 'direct' && rec.status === 'active') {
        return { record: rec, removed: true, endAs: 'ended', scheduleEmpty: false };
      }
      if (rec.participants.length > 0) {
        if (rec.participants.length <= 2) {
          for (const p of rec.participants) p.handRaised = undefined;
        }
        await this.store.save(rec);
        return { record: rec, removed: true, endAs: null, scheduleEmpty: false };
      }
      if (rec.status === 'ringing') return { record: rec, removed: true, endAs: 'cancelled', scheduleEmpty: false };
      rec.status = 'empty';
      rec.emptyAt = new Date().toISOString();
      await this.store.save(rec);
      return { record: rec, removed: true, endAs: null, scheduleEmpty: true };
    });

    await this.cancelTimer(callParticipantGraceJobId(callId, userId));
    if (!outcome.record) return null;
    if (outcome.removed) {
      await this.store.releaseSeat(userId, callId);
      this.realtime.emitPresenceCallChanged(userId, { userId, inCall: false });
    }
    if (outcome.endAs) return await this.endCall(conversationId, callId, outcome.endAs);
    if (outcome.scheduleEmpty) {
      await this.enqueueTimer(JOBS.callEmptyGrace, callEmptyGraceJobId(callId), { callId }, CALL_EMPTY_GRACE_MS);
    }
    await this.emitUpdatedToConversation(outcome.record);
    return outcome.record;
  }

  private async endCall(conversationId: string, callId: string, outcome: MessageCallOutcome): Promise<CallSessionRecord | null> {
    let seated: string[] = [];
    const ended = await this.store.withConversationLock(conversationId, async () => {
      const rec = await this.store.getByConversationId(conversationId);
      if (!rec || rec.id !== callId) return null;
      const now = new Date();
      seated = rec.participants.map((p) => p.userId);
      rec.status = 'ended';
      rec.endedAt = now.toISOString();
      rec.participants = [];
      await this.store.delete(rec);
      return rec;
    });
    if (!ended) return null;

    await Promise.all([
      this.cancelTimer(callRingTimeoutJobId(callId)),
      this.cancelTimer(callEmptyGraceJobId(callId)),
      ...seated.map((uid) => this.store.releaseSeat(uid, callId)),
    ]);
    for (const uid of seated) this.realtime.emitPresenceCallChanged(uid, { userId: uid, inCall: false });

    const durationSeconds =
      outcome === 'ended' && ended.activeAt
        ? Math.max(0, Math.round((new Date(ended.emptyAt ?? ended.endedAt!).getTime() - new Date(ended.activeAt).getTime()) / 1000))
        : null;
    if (ended.messageId) await this.safeUpdateMessage(ended, outcome, durationSeconds);
    await this.emitUpdatedToConversation(ended);
    return ended;
  }

  private toMessageCall(record: CallSessionRecord, outcome: MessageCallOutcome, durationSeconds: number | null): MessageCallDto {
    return {
      callId: record.id,
      type: record.type,
      outcome,
      durationSeconds,
      peakParticipantCount: record.peakParticipantCount,
    };
  }

  private async safeUpdateMessage(record: CallSessionRecord, outcome: MessageCallOutcome, durationSeconds: number | null): Promise<void> {
    if (!record.messageId) return;
    try {
      await this.messages.updateCallMessage({
        messageId: record.messageId,
        body: callMessageBody(record.type, outcome, durationSeconds),
        call: this.toMessageCall(record, outcome, durationSeconds),
      });
    } catch (err) {
      this.logger.warn(`[calls] failed to update call message call=${record.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private emitUpdated(userIds: Iterable<string>, record: CallSessionRecord): void {
    this.realtime.emitCallsUpdated(userIds, { conversationId: record.conversationId, call: CallSessionStore.toDto(record) });
  }

  private async emitUpdatedToConversation(record: CallSessionRecord): Promise<void> {
    let memberIds: string[] = [];
    try {
      memberIds = await this.messages.listConversationMemberUserIds(record.conversationId);
    } catch {
      memberIds = record.participants.map((p) => p.userId);
    }
    this.emitUpdated(memberIds, record);
  }

  private async enqueueTimer(name: JobName, jobId: string, payload: Record<string, string>, delay: number): Promise<void> {
    try {
      await this.jobs.enqueue(name, payload, { jobId, delay, removeOnComplete: true, removeOnFail: true });
    } catch (err) {
      // Duplicate jobId (already scheduled) or Redis hiccup — the 12h session TTL is the backstop.
      this.logger.debug(`[calls] enqueue ${name} ${jobId} skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async cancelTimer(jobId: string): Promise<void> {
    const name = jobId.startsWith('call-ring-')
      ? JOBS.callRingTimeout
      : jobId.startsWith('call-empty-')
        ? JOBS.callEmptyGrace
        : JOBS.callParticipantGrace;
    try {
      await this.jobs.removeById(name, jobId);
    } catch {
      // Already fired or never scheduled.
    }
  }

  private sanitizeDescription(raw: unknown): RtcSessionDescriptionDto | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const type = typeof r.type === 'string' ? r.type : '';
    if (!['offer', 'answer', 'pranswer', 'rollback'].includes(type)) return null;
    const sdp = typeof r.sdp === 'string' ? r.sdp : undefined;
    if (sdp && Buffer.byteLength(sdp, 'utf8') > MAX_SDP_BYTES) return null;
    return sdp !== undefined ? { type, sdp } : { type };
  }

  private sanitizeCandidate(raw: unknown): RtcIceCandidateDto | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const candidate = typeof r.candidate === 'string' ? r.candidate : null;
    if (candidate === null || candidate.length > 2_000) return null;
    return {
      candidate,
      sdpMid: typeof r.sdpMid === 'string' ? r.sdpMid : null,
      sdpMLineIndex: typeof r.sdpMLineIndex === 'number' && Number.isFinite(r.sdpMLineIndex) ? r.sdpMLineIndex : null,
      ...(typeof r.usernameFragment === 'string' ? { usernameFragment: r.usernameFragment } : {}),
    };
  }
}
