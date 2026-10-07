type RoomState<M> = {
  seq: number;
  messages: M[];
  lastWriteAtMs: number;
};

type RateState = {
  tokens: number;
  lastRefillAtMs: number;
  lastSentAtMs: number;
  lastSeenAtMs: number;
};

export type LiveChatLimits = {
  maxMessagesPerRoom: number;
  roomTtlMs: number;
  rateTtlMs: number;
  maxBodyChars: number;
  bucketCapacity: number;
  refillMsPerToken: number;
  minGapMs: number;
};

/** Shared by radio and spaces chat. */
export const DEFAULT_LIVE_CHAT_LIMITS: LiveChatLimits = {
  maxMessagesPerRoom: 220,
  roomTtlMs: 1000 * 60 * 45, // 45m since last write
  rateTtlMs: 1000 * 60 * 5, // cleanup idle rate buckets
  maxBodyChars: 280,
  bucketCapacity: 8,
  refillMsPerToken: 900, // ~0.9s per message steady-state
  minGapMs: 450, // prevent ultra-fast spam
};

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Live chat is single-line. Collapse whitespace and strip control chars. */
export function normalizeLiveChatBody(raw: string): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * In-memory, per-process live chat rooms with a per-user token-bucket send limiter.
 * Each owning service holds its own instance, so radio and spaces rate buckets stay separate.
 */
export class LiveChatStore<M> {
  private readonly rooms = new Map<string, RoomState<M>>();
  private readonly rateByUserId = new Map<string, RateState>();

  constructor(readonly limits: LiveChatLimits = DEFAULT_LIVE_CHAT_LIMITS) {}

  prune(): void {
    const now = Date.now();
    // Best-effort O(N) prune. Room count should stay tiny.
    for (const [id, st] of this.rooms.entries()) {
      if (now - st.lastWriteAtMs > this.limits.roomTtlMs) this.rooms.delete(id);
    }
    for (const [uid, rs] of this.rateByUserId.entries()) {
      if (now - rs.lastSeenAtMs > this.limits.rateTtlMs) this.rateByUserId.delete(uid);
    }
  }

  canSend(userIdRaw: string): boolean {
    const userId = String(userIdRaw ?? '').trim();
    if (!userId) return false;
    const now = Date.now();
    this.prune();

    const prev = this.rateByUserId.get(userId);
    if (!prev) {
      this.rateByUserId.set(userId, {
        tokens: this.limits.bucketCapacity - 1,
        lastRefillAtMs: now,
        lastSentAtMs: now,
        lastSeenAtMs: now,
      });
      return true;
    }

    prev.lastSeenAtMs = now;
    if (now - prev.lastSentAtMs < this.limits.minGapMs) return false;

    const elapsed = Math.max(0, now - prev.lastRefillAtMs);
    const refill = Math.floor(elapsed / this.limits.refillMsPerToken);
    if (refill > 0) {
      prev.tokens = clampInt(prev.tokens + refill, 0, this.limits.bucketCapacity);
      prev.lastRefillAtMs = now;
    }

    if (prev.tokens <= 0) return false;
    prev.tokens -= 1;
    prev.lastSentAtMs = now;
    return true;
  }

  clip(body: string): string {
    return body.length > this.limits.maxBodyChars ? body.slice(0, this.limits.maxBodyChars) : body;
  }

  messages(roomIdRaw: string): M[] | undefined {
    return this.rooms.get(String(roomIdRaw ?? '').trim())?.messages;
  }

  /** Marks a write and returns the room's next sequence number. */
  beginWrite(roomId: string, now: number): { seq: number; messages: M[] } {
    const st = this.getOrInit(roomId);
    st.lastWriteAtMs = now;
    st.seq += 1;
    return { seq: st.seq, messages: st.messages };
  }

  push(roomId: string, msg: M): void {
    const st = this.getOrInit(roomId);
    st.messages.push(msg);
    const overflow = st.messages.length - this.limits.maxMessagesPerRoom;
    if (overflow > 0) st.messages.splice(0, overflow);
  }

  private getOrInit(roomId: string): RoomState<M> {
    const id = (roomId ?? '').trim();
    const existing = this.rooms.get(id);
    if (existing) return existing;
    const st: RoomState<M> = { seq: 0, messages: [], lastWriteAtMs: Date.now() };
    this.rooms.set(id, st);
    return st;
  }
}
