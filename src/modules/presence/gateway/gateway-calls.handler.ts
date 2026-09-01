import { Injectable, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import type { CallsAckDto, CallType } from '../../../common/dto';
import { CallsService } from '../../calls/calls.service';
import { PresenceService } from '../presence.service';

type BoundCall = { callId: string; userId: string };

/**
 * DM calling over the socket. Every lifecycle action is acked with `CallsAckDto` so
 * the client gets `{ call, iceServers }` or `{ error }` without an HTTP round-trip.
 * The joining socket is bound to its participant so a dropped tab can be detected.
 */
@Injectable()
export class CallsGatewayHandler {
  private readonly logger = new Logger(CallsGatewayHandler.name);
  /** socketId → the call this socket is a participant of (this instance only). */
  private readonly boundCallBySocket = new Map<string, BoundCall>();

  constructor(
    private readonly presence: PresenceService,
    private readonly calls: CallsService,
  ) {}

  private notAuthed(): CallsAckDto {
    return { call: null, error: { code: 'not_authenticated', message: 'Sign in to use calls.' } };
  }

  private invalid(message: string): CallsAckDto {
    return { call: null, error: { code: 'invalid_payload', message } };
  }

  private bind(client: Socket, ack: CallsAckDto, userId: string): CallsAckDto {
    if (ack.call && !ack.error) this.boundCallBySocket.set(client.id, { callId: ack.call.id, userId });
    return ack;
  }

  async handleCallsStart(client: Socket, payload: { conversationId?: string; type?: string }): Promise<CallsAckDto> {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return this.notAuthed();
    const conversationId = String(payload?.conversationId ?? '').trim();
    const type: CallType | null = payload?.type === 'audio' || payload?.type === 'video' ? payload.type : null;
    if (!conversationId || !type) return this.invalid('Missing conversation or call type.');
    try {
      const ack = await this.calls.start({ userId, socketId: client.id, conversationId, type });
      return this.bind(client, ack, userId);
    } catch (err) {
      this.logger.warn(`[calls] start failed user=${userId}: ${err instanceof Error ? err.message : String(err)}`);
      return this.invalid('Could not start the call. Try again.');
    }
  }

  async handleCallsJoin(client: Socket, payload: { callId?: string }): Promise<CallsAckDto> {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return this.notAuthed();
    const callId = String(payload?.callId ?? '').trim();
    if (!callId) return this.invalid('Missing call id.');
    try {
      const ack = await this.calls.join({ userId, socketId: client.id, callId });
      return this.bind(client, ack, userId);
    } catch (err) {
      this.logger.warn(`[calls] join failed user=${userId}: ${err instanceof Error ? err.message : String(err)}`);
      return this.invalid('Could not join the call. Try again.');
    }
  }

  async handleCallsLeave(client: Socket, payload: { callId?: string }): Promise<CallsAckDto> {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return this.notAuthed();
    const callId = String(payload?.callId ?? '').trim();
    if (!callId) return this.invalid('Missing call id.');
    const bound = this.boundCallBySocket.get(client.id);
    if (bound?.callId === callId) this.boundCallBySocket.delete(client.id);
    try {
      return await this.calls.leave({ userId, callId });
    } catch (err) {
      this.logger.warn(`[calls] leave failed user=${userId}: ${err instanceof Error ? err.message : String(err)}`);
      return { call: null };
    }
  }

  async handleCallsDecline(client: Socket, payload: { callId?: string }): Promise<CallsAckDto> {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return this.notAuthed();
    const callId = String(payload?.callId ?? '').trim();
    if (!callId) return this.invalid('Missing call id.');
    try {
      return await this.calls.decline({ userId, callId });
    } catch (err) {
      this.logger.warn(`[calls] decline failed user=${userId}: ${err instanceof Error ? err.message : String(err)}`);
      return { call: null };
    }
  }

  async handleCallsState(client: Socket, payload: { callId?: string; micEnabled?: boolean; cameraEnabled?: boolean }): Promise<void> {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return;
    const callId = String(payload?.callId ?? '').trim();
    if (!callId) return;
    // Only the bound participant socket may change its own flags.
    if (this.boundCallBySocket.get(client.id)?.callId !== callId) return;
    try {
      await this.calls.updateParticipantState({
        userId,
        callId,
        ...(typeof payload?.micEnabled === 'boolean' ? { micEnabled: payload.micEnabled } : {}),
        ...(typeof payload?.cameraEnabled === 'boolean' ? { cameraEnabled: payload.cameraEnabled } : {}),
      });
    } catch {
      // Best-effort; the next state change resyncs.
    }
  }

  async handleRtcSignal(
    client: Socket,
    payload: { callId?: string; toUserId?: string; description?: unknown; candidate?: unknown },
  ): Promise<void> {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return;
    const callId = String(payload?.callId ?? '').trim();
    const toUserId = String(payload?.toUserId ?? '').trim();
    if (!callId || !toUserId) return;
    // Signaling may only originate from the socket that joined the call.
    if (this.boundCallBySocket.get(client.id)?.callId !== callId) return;
    try {
      await this.calls.relaySignal({
        fromUserId: userId,
        callId,
        toUserId,
        description: payload?.description,
        candidate: payload?.candidate,
      });
    } catch (err) {
      this.logger.debug(`[calls] relay failed user=${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Socket dropped mid-call: hold the seat for a grace period so a reconnect can resume. */
  handleDisconnect(client: Socket): void {
    const bound = this.boundCallBySocket.get(client.id);
    if (!bound) return;
    this.boundCallBySocket.delete(client.id);
    void this.calls
      .markParticipantReconnecting({ userId: bound.userId, callId: bound.callId, socketId: client.id })
      .catch((err) => {
        this.logger.warn(`[calls] disconnect grace failed user=${bound.userId}: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /** Test seam. */
  isSocketBound(socketId: string): boolean {
    return this.boundCallBySocket.has(socketId);
  }
}
