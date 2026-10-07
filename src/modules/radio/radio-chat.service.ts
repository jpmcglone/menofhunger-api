import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { RadioChatMessageDto, RadioChatSenderDto, RadioChatSnapshotDto } from '../../common/dto';
import { LiveChatStore, normalizeLiveChatBody } from '../../common/live-chat/live-chat-store';

@Injectable()
export class RadioChatService {
  private readonly store = new LiveChatStore<RadioChatMessageDto>();

  @Interval(60_000)
  pruneInterval(): void {
    this.store.prune();
  }

  canSend(userIdRaw: string): boolean {
    return this.store.canSend(userIdRaw);
  }

  snapshot(stationIdRaw: string): RadioChatSnapshotDto {
    const stationId = String(stationIdRaw ?? '').trim();
    return { stationId, messages: this.store.messages(stationId) ?? [] };
  }

  appendMessage(params: { stationId: string; sender: RadioChatSenderDto; body: string }): RadioChatMessageDto | null {
    const stationId = String(params.stationId ?? '').trim();
    if (!stationId) return null;
    this.store.prune();
    const body = normalizeLiveChatBody(params.body);
    if (!body) return null;
    const clipped = this.store.clip(body);

    const now = Date.now();
    const { seq } = this.store.beginWrite(stationId, now);

    const id = `${stationId}:${now.toString(36)}:${seq.toString(36)}`;
    const createdAt = new Date(now).toISOString();
    const msg: RadioChatMessageDto = {
      id,
      stationId,
      body: clipped,
      createdAt,
      sender: params.sender,
    };

    this.store.push(stationId, msg);
    return msg;
  }
}
