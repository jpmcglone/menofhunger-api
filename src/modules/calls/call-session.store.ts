import { Injectable } from '@nestjs/common';
import type { CallParticipantConnectionState, CallSessionDto, CallStatus, CallType } from '../../common/dto/call.dto';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { CALL_SESSION_TTL_SECONDS } from './calls.constants';

/**
 * Server-side call participant. Extends the DTO with the bound socket so the
 * disconnect handler can tell "this tab dropped" from "another tab is still here".
 */
export type CallParticipantRecord = {
  userId: string;
  joinedAt: string;
  micEnabled: boolean;
  cameraEnabled: boolean;
  connectionState: CallParticipantConnectionState;
  screenSharing?: boolean;
  socketId: string | null;
  /** When the seat entered `reconnecting`; lets the sweep expire it even if the grace job was lost. */
  disconnectedAt?: string | null;
};

export type CallSessionRecord = {
  id: string;
  conversationId: string;
  conversationType: 'direct' | 'group' | 'crew_wall';
  type: CallType;
  status: CallStatus;
  startedByUserId: string;
  startedByAdmin: boolean;
  startedAt: string;
  /** First moment the call had ≥1 connected participant after ringing (direct) or at start (group). */
  activeAt: string | null;
  /** Set when the last participant left; cleared if someone comes back during the grace window. */
  emptyAt: string | null;
  endedAt: string | null;
  capacity: number;
  messageId: string | null;
  /** Direct calls: the callee being rung. */
  ringTargetUserId: string | null;
  peakParticipantCount: number;
  participants: CallParticipantRecord[];
};

/**
 * Redis is the single source of truth for live call sessions. No in-memory cache: the
 * API process and the worker process (which fires ring/grace timers) both mutate it, and
 * a stale cache would let a join exceed capacity or a timer end a call someone rejoined.
 */
@Injectable()
export class CallSessionStore {
  constructor(private readonly redis: RedisService) {}

  async getByConversationId(conversationId: string): Promise<CallSessionRecord | null> {
    const id = (conversationId ?? '').trim();
    if (!id) return null;
    return await this.redis.getJson<CallSessionRecord>(RedisKeys.callSessionByConversation(id));
  }

  async getByCallId(callId: string): Promise<CallSessionRecord | null> {
    const cid = (callId ?? '').trim();
    if (!cid) return null;
    const conversationId = await this.redis.getString(RedisKeys.callConversationByCallId(cid));
    if (!conversationId) return null;
    const record = await this.getByConversationId(conversationId);
    // The conversation key may already point at a newer call.
    return record && record.id === cid ? record : null;
  }

  /** Batched lookup for conversation lists. Ended sessions are never stored, so any hit is live. */
  async getManyByConversationIds(conversationIds: string[]): Promise<Map<string, CallSessionRecord>> {
    const ids = [...new Set(conversationIds.map((id) => (id ?? '').trim()).filter(Boolean))];
    const out = new Map<string, CallSessionRecord>();
    if (ids.length === 0) return out;
    let rows: Array<CallSessionRecord | null> = [];
    try {
      rows = await this.redis.getJsonMany<CallSessionRecord>(ids.map((id) => RedisKeys.callSessionByConversation(id)));
    } catch {
      return out;
    }
    rows.forEach((row, i) => {
      if (row) out.set(ids[i]!, row);
    });
    return out;
  }

  /**
   * Persist the session and point every current participant's seat index at it. Seats of
   * participants who were removed are released by the service (`releaseSeat`), which knows
   * who left; here we only know who is still in.
   */
  async save(record: CallSessionRecord): Promise<void> {
    await Promise.all([
      this.redis.setJson(RedisKeys.callSessionByConversation(record.conversationId), record, {
        ttlSeconds: CALL_SESSION_TTL_SECONDS,
      }),
      this.redis.setString(RedisKeys.callConversationByCallId(record.id), record.conversationId, {
        ttlSeconds: CALL_SESSION_TTL_SECONDS,
      }),
      ...record.participants.map((p) =>
        this.redis.setString(RedisKeys.callByUserId(p.userId), record.id, { ttlSeconds: CALL_SESSION_TTL_SECONDS }),
      ),
      this.redis.raw().sadd(RedisKeys.callsLive(), record.conversationId),
    ]);
  }

  async delete(record: Pick<CallSessionRecord, 'id' | 'conversationId'>): Promise<void> {
    await Promise.all([
      this.redis.del(RedisKeys.callSessionByConversation(record.conversationId), RedisKeys.callConversationByCallId(record.id)),
      this.redis.raw().srem(RedisKeys.callsLive(), record.conversationId),
    ]);
  }

  /** Conversations the sweep should inspect. Entries whose session is gone are pruned by the caller. */
  async listLiveConversationIds(): Promise<string[]> {
    try {
      return (await this.redis.raw().smembers(RedisKeys.callsLive())) ?? [];
    } catch {
      return [];
    }
  }

  async forgetLiveConversation(conversationId: string): Promise<void> {
    try {
      await this.redis.raw().srem(RedisKeys.callsLive(), conversationId);
    } catch {
      // Next sweep retries.
    }
  }

  // ─── One seat per member ──────────────────────────────────────────────────────

  /** The call this user currently holds a seat in, if any. Verified against the live record. */
  async getCallIdForUser(userId: string): Promise<string | null> {
    const uid = (userId ?? '').trim();
    if (!uid) return null;
    const callId = await this.redis.getString(RedisKeys.callByUserId(uid));
    if (!callId) return null;
    const record = await this.getByCallId(callId);
    if (!record || record.status === 'ended' || !record.participants.some((p) => p.userId === uid)) {
      // Stale pointer (the call ended or they were removed without a release); self-heal.
      await this.releaseSeat(uid, callId);
      return null;
    }
    return callId;
  }

  /** Drop the seat pointer, but only if it still points at `callId` — never clobber a newer seat. */
  async releaseSeat(userId: string, callId: string): Promise<void> {
    const uid = (userId ?? '').trim();
    if (!uid) return;
    const current = await this.redis.getString(RedisKeys.callByUserId(uid));
    if (current === callId) await this.redis.del(RedisKeys.callByUserId(uid));
  }

  /** Batched "is in a call" for presence surfaces. Pointer presence is enough; stale ones expire. */
  async inCallByUserIds(userIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(userIds.map((id) => (id ?? '').trim()).filter(Boolean))];
    const out = new Set<string>();
    if (ids.length === 0) return out;
    try {
      const rows = await this.redis.getStringMany(ids.map((id) => RedisKeys.callByUserId(id)));
      rows.forEach((row, i) => {
        if (row) out.add(ids[i]!);
      });
    } catch {
      return out;
    }
    return out;
  }

  /**
   * Serialize mutations per conversation so two simultaneous joins at 3/4 can't both
   * succeed. Falls back to running unlocked if Redis is under contention rather than
   * failing the user's action outright.
   */
  async withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const result = await this.redis.withLock(
      RedisKeys.callSessionLock(conversationId),
      { ttlMs: 3_000, waitMs: 1_500, retryDelayMs: 20 },
      fn,
    );
    if (result !== null) return result;
    return await fn();
  }

  static toDto(record: CallSessionRecord): CallSessionDto {
    return {
      id: record.id,
      conversationId: record.conversationId,
      type: record.type,
      status: record.status,
      startedByUserId: record.startedByUserId,
      startedByAdmin: record.startedByAdmin,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      capacity: record.capacity,
      messageId: record.messageId,
      participants: record.participants.map((p) => ({
        userId: p.userId,
        joinedAt: p.joinedAt,
        micEnabled: p.micEnabled,
        cameraEnabled: p.cameraEnabled,
        connectionState: p.connectionState,
        ...(p.screenSharing ? { screenSharing: true } : {}),
      })),
    };
  }
}
