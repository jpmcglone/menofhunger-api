import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { SpaceChatMediaItemDto, SpaceChatMessageDto, SpaceChatSenderDto, SpaceChatSnapshotDto } from '../../common/dto';
import { LiveChatStore, normalizeLiveChatBody } from '../../common/live-chat/live-chat-store';

function systemBodyFor(first: 'join' | 'leave', last: 'join' | 'leave', label: string): string {
  const firstWord = first === 'join' ? 'joined' : 'left';
  const lastWord = last === 'join' ? 'joined' : 'left';
  const combined = firstWord === lastWord ? firstWord : `${firstWord} and ${lastWord}`;
  return normalizeLiveChatBody(`${label} has ${combined} the chat`);
}

@Injectable()
export class SpacesChatService {
  private readonly store = new LiveChatStore<SpaceChatMessageDto>();

  @Interval(60_000)
  pruneInterval(): void {
    this.store.prune();
  }

  canSend(userIdRaw: string): boolean {
    return this.store.canSend(userIdRaw);
  }

  snapshot(spaceIdRaw: string): SpaceChatSnapshotDto {
    const spaceId = String(spaceIdRaw ?? '').trim();
    // Live-only: no history/backfill. Clients should only see messages sent while they’re present.
    return { spaceId, messages: [] };
  }

  private readonly maxMediaPerMessage = 4;

  private sanitizeMedia(raw: unknown): SpaceChatMediaItemDto[] | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const out: SpaceChatMediaItemDto[] = [];
    for (const item of raw.slice(0, this.maxMediaPerMessage)) {
      if (!item || typeof item !== 'object') continue;
      const url = String((item as any).url ?? '').trim();
      if (!url || url.length > 2048) continue;
      out.push({
        url,
        width: typeof (item as any).width === 'number' ? Math.floor((item as any).width) : null,
        height: typeof (item as any).height === 'number' ? Math.floor((item as any).height) : null,
        alt: typeof (item as any).alt === 'string' ? (item as any).alt.slice(0, 300).trim() || null : null,
      });
    }
    return out.length > 0 ? out : undefined;
  }

  appendMessage(params: {
    spaceId: string;
    sender: SpaceChatSenderDto;
    body: string;
    media?: unknown;
    replyToId?: string | null;
  }): SpaceChatMessageDto | null {
    const spaceId = String(params.spaceId ?? '').trim();
    if (!spaceId) return null;
    this.store.prune();
    const body = normalizeLiveChatBody(params.body);
    const media = this.sanitizeMedia(params.media);
    if (!body && !media) return null;
    const clipped = this.store.clip(body);

    const now = Date.now();
    const { seq } = this.store.beginWrite(spaceId, now);

    const replyToId = String(params.replyToId ?? '').trim() || null;
    const id = `${spaceId}:${now.toString(36)}:${seq.toString(36)}`;
    const createdAt = new Date(now).toISOString();
    const msg: SpaceChatMessageDto = {
      id,
      spaceId,
      kind: 'user',
      body: clipped,
      ...(media ? { media } : {}),
      createdAt,
      sender: params.sender,
      ...(replyToId ? { replyToId } : {}),
    };

    this.store.push(spaceId, msg);
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
    this.store.prune();
    const userId = String(params.userId ?? '').trim();
    if (!userId) return null;
    const usernameRaw = (params.username ?? null) as string | null;
    const username = usernameRaw ? String(usernameRaw).trim() || null : null;
    const label = username ? `@${username}` : 'Someone';
    const body = systemBodyFor(params.event, params.event, label);
    if (!body) return null;
    const clipped = this.store.clip(body);

    const now = Date.now();
    const { seq, messages } = this.store.beginWrite(spaceId, now);

    const createdAt = new Date(now).toISOString();
    const existingLast = messages.at(-1) ?? null;

    // If the most recent message is this same user's system message, collapse it (back-to-back only).
    // Sliding window: firstEvent is the previous lastEvent, so leave→join reads
    // "left and joined" instead of freezing the original join forever.
    if (
      existingLast &&
      existingLast.kind === 'system' &&
      existingLast.system?.userId === userId
    ) {
      const prevLast = (existingLast.system as any)?.lastEvent ?? (existingLast.system as any)?.firstEvent ?? 'join';
      const prevLastEvent = (prevLast === 'join' || prevLast === 'leave') ? prevLast : 'join';
      if (prevLastEvent === params.event) {
        return existingLast;
      }
      const firstEvent = prevLastEvent;
      const lastEvent = params.event;
      const collapsedBody = this.store.clip(systemBodyFor(firstEvent, lastEvent, label));
      const next: SpaceChatMessageDto = {
        ...existingLast,
        kind: 'system',
        system: { firstEvent, lastEvent, userId, username },
        body: collapsedBody,
        createdAt,
        sender: null,
      };
      messages[messages.length - 1] = next;
      return next;
    }

    const id = `${spaceId}:${now.toString(36)}:${seq.toString(36)}:sys`;
    const msg: SpaceChatMessageDto = {
      id,
      spaceId,
      kind: 'system',
      system: { firstEvent: params.event, lastEvent: params.event, userId, username },
      body: clipped,
      createdAt,
      sender: null,
    };

    this.store.push(spaceId, msg);
    return msg;
  }
}
