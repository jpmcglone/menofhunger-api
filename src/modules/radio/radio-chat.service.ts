import { Injectable } from '@nestjs/common';
import type { RadioChatMessageDto, RadioChatSenderDto, RadioChatSnapshotDto } from '../../common/dto';

type StationState = {
  seq: number;
  messages: RadioChatMessageDto[];
  lastWriteAtMs: number;
};

type RateState = {
  tokens: number;
  lastRefillAtMs: number;
  lastSentAtMs: number;
  lastSeenAtMs: number;
};

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeBody(raw: string): string {
  // Live chat is single-line. Collapse whitespace and strip control chars.
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

@Injectable()
export class RadioChatService {
  private readonly byStation = new Map<string, StationState>();
  private readonly rateByUserId = new Map<string, RateState>();

  // Bounds for memory/perf safety.
  private readonly maxMessagesPerStation = 220;
  private readonly stationTtlMs = 1000 * 60 * 45; // 45m since last write
  private readonly rateTtlMs = 1000 * 60 * 5; // cleanup idle rate buckets
  private readonly maxBodyChars = 280;

  // Token bucket for send throttling.
  private readonly bucketCapacity = 8;
  private readonly refillMsPerToken = 900; // ~0.9s per message steady-state
  private readonly minGapMs = 450; // prevent ultra-fast spam

  private getOrInitStation(stationId: string): StationState {
    const sid = (stationId ?? '').trim();
    const existing = this.byStation.get(sid);
    if (existing) return existing;
    const st: StationState = { seq: 0, messages: [], lastWriteAtMs: Date.now() };
    this.byStation.set(sid, st);
    return st;
  }

  private maybePrune(): void {
    const now = Date.now();
    // Best-effort O(N) prune. Station count should stay tiny.
    for (const [sid, st] of this.byStation.entries()) {
      if (now - st.lastWriteAtMs > this.stationTtlMs) this.byStation.delete(sid);
    }
    for (const [uid, rs] of this.rateByUserId.entries()) {
      if (now - rs.lastSeenAtMs > this.rateTtlMs) this.rateByUserId.delete(uid);
    }
  }

  canSend(userIdRaw: string): boolean {
    const userId = String(userIdRaw ?? '').trim();
    if (!userId) return false;
    const now = Date.now();
    this.maybePrune();

    const prev = this.rateByUserId.get(userId);
    if (!prev) {
      this.rateByUserId.set(userId, {
        tokens: this.bucketCapacity - 1,
        lastRefillAtMs: now,
        lastSentAtMs: now,
        lastSeenAtMs: now,
      });
      return true;
    }

    prev.lastSeenAtMs = now;
    if (now - prev.lastSentAtMs < this.minGapMs) return false;

    // Refill tokens.
    const elapsed = Math.max(0, now - prev.lastRefillAtMs);
    const refill = Math.floor(elapsed / this.refillMsPerToken);
    if (refill > 0) {
      prev.tokens = clampInt(prev.tokens + refill, 0, this.bucketCapacity);
      prev.lastRefillAtMs = now;
    }

    if (prev.tokens <= 0) return false;
    prev.tokens -= 1;
    prev.lastSentAtMs = now;
    return true;
  }

  snapshot(stationIdRaw: string): RadioChatSnapshotDto {
    const stationId = String(stationIdRaw ?? '').trim();
    const st = this.byStation.get(stationId);
    return { stationId, messages: st?.messages ?? [] };
  }

  appendMessage(params: { stationId: string; sender: RadioChatSenderDto; body: string }): RadioChatMessageDto | null {
    const stationId = String(params.stationId ?? '').trim();
    if (!stationId) return null;
    const body = normalizeBody(params.body);
    if (!body) return null;
    const clipped = body.length > this.maxBodyChars ? body.slice(0, this.maxBodyChars) : body;

    const now = Date.now();
    const st = this.getOrInitStation(stationId);
    st.lastWriteAtMs = now;
    st.seq += 1;

    const id = `${stationId}:${now.toString(36)}:${st.seq.toString(36)}`;
    const createdAt = new Date(now).toISOString();
    const msg: RadioChatMessageDto = {
      id,
      stationId,
      body: clipped,
      createdAt,
      sender: params.sender,
    };

    st.messages.push(msg);
    const overflow = st.messages.length - this.maxMessagesPerStation;
    if (overflow > 0) st.messages.splice(0, overflow);
    return msg;
  }
}

