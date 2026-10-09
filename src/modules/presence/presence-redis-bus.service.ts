import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as crypto from 'node:crypto';
import type Redis from 'ioredis';
import { Interval } from '@nestjs/schedule';
import { RedisKeys } from '../redis/redis-keys';
import { RedisService } from '../redis/redis.service';
import { INSTANCE_HEARTBEAT_MS, INSTANCE_HEARTBEAT_TTL_SECONDS, type PresenceEvent } from './presence-redis-state.constants';

/** Cross-instance presence pub/sub: this instance's identity and liveness beacon, the subscriber, and every publish. */
@Injectable()
export class PresenceRedisBusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PresenceRedisBusService.name);
  private readonly instanceId = crypto.randomUUID().slice(0, 12);
  private readonly sub: Redis;
  private readonly listeners = new Set<(evt: PresenceEvent) => void>();

  constructor(private readonly redis: RedisService) {
    // Subscriber connections must not run the ready-check: ioredis sends INFO
    // for the check, which is rejected in subscriber mode after a reconnect.
    this.sub = this.redis.duplicate({ enableReadyCheck: false });
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  async publish(evt: PresenceEvent): Promise<void> {
    try {
      await this.redis.raw().publish(RedisKeys.presencePubSubChannel(), JSON.stringify(evt));
    } catch {
      // best-effort
    }
  }

  onEvent(handler: (evt: PresenceEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  @Interval(INSTANCE_HEARTBEAT_MS)
  async heartbeatInstance(): Promise<void> {
    try {
      await this.redis.setString(RedisKeys.presenceInstance(this.instanceId), '1', {
        ttlSeconds: INSTANCE_HEARTBEAT_TTL_SECONDS,
      });
    } catch {
      // Next tick retries; a missed beat only shortens the grace for our sockets.
    }
  }

  async onModuleInit(): Promise<void> {
    await this.heartbeatInstance();
    try {
      await this.sub.subscribe(RedisKeys.presencePubSubChannel());
      this.sub.on('message', (_channel, message) => {
        try {
          const parsed = JSON.parse(message) as PresenceEvent;
          if (!parsed || typeof parsed.type !== 'string') return;
          // Most events require userId; these types are count/broadcast-only.
          const typesWithoutUserId = new Set<string>(['spacesLobbyCounts', 'broadcast', 'anonymousCount']);
          if (!typesWithoutUserId.has(parsed.type) && typeof (parsed as { userId?: unknown }).userId !== 'string') return;
          for (const fn of this.listeners) {
            try {
              fn(parsed);
            } catch {
              // ignore listener failures
            }
          }
        } catch {
          // ignore
        }
      });
    } catch (err) {
      this.logger.warn(`[presence] Failed to subscribe to pubsub: ${err}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.sub.quit();
    } catch {
      this.sub.disconnect();
    }
  }

  /**
   * Cross-instance targeted emit (best-effort).
   * Each instance will deliver to its local sockets for the user.
   */
  async publishEmitToUser(params: { userId: string; event: string; payload: unknown }): Promise<void> {
    const userId = String(params.userId ?? '').trim();
    const event = String(params.event ?? '').trim();
    if (!userId || !event) return;
    await this.publish({ type: 'emitToUser', userId, instanceId: this.instanceId, event, payload: params.payload });
  }

  /**
   * Cross-instance broadcast of space lobby counts.
   * All instances will emit the updated counts to all their connected sockets.
   */
  async publishSpacesLobbyCounts(countsBySpaceId: Record<string, number>): Promise<void> {
    await this.publish({ type: 'spacesLobbyCounts', instanceId: this.instanceId, countsBySpaceId });
  }

  /**
   * Cross-instance: notify subscribers of a user that their space changed.
   * Each instance emits to its local subscribers of that user.
   */
  async publishUserSpaceChanged(params: {
    userId: string;
    spaceId: string | null;
    previousSpaceId?: string;
  }): Promise<void> {
    const userId = String(params.userId ?? '').trim();
    if (!userId) return;
    await this.publish({
      type: 'userSpaceChanged',
      userId,
      instanceId: this.instanceId,
      spaceId: params.spaceId ?? null,
      previousSpaceId: params.previousSpaceId,
    });
  }

  /**
   * Cross-instance: notify subscribers of a user that their plain-text status changed.
   * Each instance emits to its local subscribers of that user.
   */
  async publishUserStatusChanged(params: { userId: string; event: string; payload: unknown }): Promise<void> {
    const userId = String(params.userId ?? '').trim();
    const event = String(params.event ?? '').trim();
    if (!userId || !event) return;
    await this.publish({
      type: 'userStatusChanged',
      userId,
      instanceId: this.instanceId,
      event,
      payload: params.payload,
    });
  }

  /**
   * Cross-instance room emit (best-effort).
   * Used for scoped subscriptions (e.g. per-post live updates).
   */
  async publishEmitToRoom(params: { room: string; event: string; payload: unknown }): Promise<void> {
    const room = String(params.room ?? '').trim();
    const event = String(params.event ?? '').trim();
    if (!room || !event) return;
    // `userId` remains required by the pubsub envelope; use '-' for room emits.
    await this.publish({ type: 'emitToRoom', userId: '-', instanceId: this.instanceId, room, event, payload: params.payload });
  }

  /**
   * Cross-instance global broadcast (best-effort). Every instance re-emits to all of its
   * connected sockets. Needed so broadcasts originating from a worker process (which has no
   * Socket.IO server of its own) still reach clients.
   */
  async publishBroadcast(params: { event: string; payload: unknown; required?: boolean }): Promise<void> {
    const event = String(params.event ?? '').trim();
    if (!event) return;
    const message: PresenceEvent = { type: 'broadcast', instanceId: this.instanceId, event, payload: params.payload };
    if (params.required) {
      await this.redis.raw().publish(RedisKeys.presencePubSubChannel(), JSON.stringify(message));
    } else {
      await this.publish(message);
    }
  }
}
