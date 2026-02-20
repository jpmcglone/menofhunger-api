import { Injectable } from '@nestjs/common';
import type { SpaceChatMessageDto, SpaceChatSenderDto, SpaceChatSnapshotDto } from '../../common/dto';

type SpaceState = {
  seq: number;
  messages: SpaceChatMessageDto[];
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

function systemBodyFor(first: 'join' | 'leave', last: 'join' | 'leave', label: string): string {
  const firstWord = first === 'join' ? 'joined' : 'left'
  const lastWord = last === 'join' ? 'joined' : 'left'
  const combined = firstWord === lastWord ? firstWord : `${firstWord} and ${lastWord}`
  return normalizeBody(`${label} has ${combined} the chat`)
}

@Injectable()
export class SpacesChatService {
  private readonly bySpace = new Map<string, SpaceState>();
  private readonly rateByUserId = new Map<string, RateState>();

  private readonly maxMessagesPerSpace = 220;
  private readonly spaceTtlMs = 1000 * 60 * 45; // 45m since last write
  private readonly rateTtlMs = 1000 * 60 * 5; // cleanup idle rate buckets
  private readonly maxBodyChars = 280;

  // Token bucket for send throttling.
  private readonly bucketCapacity = 8;
  private readonly refillMsPerToken = 900;
  private readonly minGapMs = 450;

  private getOrInitSpace(spaceId: string): SpaceState {
    const sid = (spaceId ?? '').trim();
    const existing = this.bySpace.get(sid);
    if (existing) return existing;
    const st: SpaceState = { seq: 0, messages: [], lastWriteAtMs: Date.now() };
    this.bySpace.set(sid, st);
    return st;
  }

  private maybePrune(): void {
    const now = Date.now();
    for (const [sid, st] of this.bySpace.entries()) {
      if (now - st.lastWriteAtMs > this.spaceTtlMs) this.bySpace.delete(sid);
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

  snapshot(spaceIdRaw: string): SpaceChatSnapshotDto {
    const spaceId = String(spaceIdRaw ?? '').trim();
    // Live-only: no history/backfill. Clients should only see messages sent while they’re present.
    return { spaceId, messages: [] };
  }

  appendMessage(params: { spaceId: string; sender: SpaceChatSenderDto; body: string }): SpaceChatMessageDto | null {
    const spaceId = String(params.spaceId ?? '').trim();
    if (!spaceId) return null;
    const body = normalizeBody(params.body);
    if (!body) return null;
    const clipped = body.length > this.maxBodyChars ? body.slice(0, this.maxBodyChars) : body;

    const now = Date.now();
    const st = this.getOrInitSpace(spaceId);
    st.lastWriteAtMs = now;
    st.seq += 1;

    const id = `${spaceId}:${now.toString(36)}:${st.seq.toString(36)}`;
    const createdAt = new Date(now).toISOString();
    const msg: SpaceChatMessageDto = {
      id,
      spaceId,
      kind: 'user',
      body: clipped,
      createdAt,
      sender: params.sender,
    };

    st.messages.push(msg);
    const overflow = st.messages.length - this.maxMessagesPerSpace;
    if (overflow > 0) st.messages.splice(0, overflow);
    return msg;
  }

  appendSystemMessage(params: {
    spaceId: string;
    event: 'join' | 'leave';
    userId: string;
    username: string | null;
  }): SpaceChatMessageDto | null {
    const spaceId = String(params.spaceId ?? '').trim();
    if (!spaceId) return null;
    const userId = String(params.userId ?? '').trim();
    if (!userId) return null;
    const usernameRaw = (params.username ?? null) as string | null;
    const username = usernameRaw ? String(usernameRaw).trim() || null : null;
    const label = username ? `@${username}` : 'Someone';
    const body = systemBodyFor(params.event, params.event, label)
    if (!body) return null;
    const clipped = body.length > this.maxBodyChars ? body.slice(0, this.maxBodyChars) : body;

    const now = Date.now();
    const st = this.getOrInitSpace(spaceId);
    st.lastWriteAtMs = now;
    st.seq += 1;

    const createdAt = new Date(now).toISOString();
    const existingLast = st.messages.at(-1) ?? null;

    // If the most recent message is this same user's system message, collapse it (back-to-back only).
    if (
      existingLast &&
      existingLast.kind === 'system' &&
      existingLast.system?.userId === userId
    ) {
      const prevFirst = (existingLast.system as any)?.firstEvent ?? (existingLast.system as any)?.event ?? 'join'
      const prevLast = (existingLast.system as any)?.lastEvent ?? (existingLast.system as any)?.event ?? prevFirst
      const firstEvent = (prevFirst === 'join' || prevFirst === 'leave') ? prevFirst : 'join'
      const lastEvent = params.event
      const collapsedBodyRaw = systemBodyFor(firstEvent, lastEvent, label)
      const collapsedBody = collapsedBodyRaw.length > this.maxBodyChars
        ? collapsedBodyRaw.slice(0, this.maxBodyChars)
        : collapsedBodyRaw
      const next: SpaceChatMessageDto = {
        ...existingLast,
        kind: 'system',
        system: { firstEvent, lastEvent, userId, username },
        body: collapsedBody,
        createdAt,
        sender: null,
      };
      st.messages[st.messages.length - 1] = next;
      return next;
    }

    const id = `${spaceId}:${now.toString(36)}:${st.seq.toString(36)}:sys`;
    const msg: SpaceChatMessageDto = {
      id,
      spaceId,
      kind: 'system',
      system: { firstEvent: params.event, lastEvent: params.event, userId, username },
      body: clipped,
      createdAt,
      sender: null,
    };

    st.messages.push(msg);
    const overflow = st.messages.length - this.maxMessagesPerSpace;
    if (overflow > 0) st.messages.splice(0, overflow);
    return msg;
  }
}

