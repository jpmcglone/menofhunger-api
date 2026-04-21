import { Injectable } from '@nestjs/common';
import type { WatchPartyStateDto } from '../../common/dto';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';

interface WatchPartyState {
  videoUrl: string;
  isPlaying: boolean;
  currentTime: number;
  playbackRate: number;
  updatedAt: number;
}

/** 4-hour TTL — well beyond any realistic watch party session. */
const WP_STATE_TTL_SECONDS = 14_400;

@Injectable()
export class WatchPartyStateService {
  private readonly stateBySpaceId = new Map<string, WatchPartyState>();

  constructor(private readonly redis: RedisService) {}

  setState(spaceId: string, params: { videoUrl: string; isPlaying: boolean; currentTime: number; playbackRate: number }): void {
    const state: WatchPartyState = {
      videoUrl: params.videoUrl,
      isPlaying: params.isPlaying,
      currentTime: params.currentTime,
      playbackRate: params.playbackRate,
      updatedAt: Date.now(),
    };
    this.stateBySpaceId.set(spaceId, state);
    void this.redis.setJson(RedisKeys.watchPartyState(spaceId), state, { ttlSeconds: WP_STATE_TTL_SECONDS }).catch(() => undefined);
  }

  /**
   * Sync read from in-memory only. Use for hot paths (e.g. disconnect handlers).
   * Returns drift-adjusted currentTime when the video is playing.
   */
  getState(spaceId: string): WatchPartyStateDto | null {
    const state = this.stateBySpaceId.get(spaceId);
    if (!state) return null;
    return this.toDto(state);
  }

  /**
   * Async read: checks memory first, then Redis.
   * Use this when joining a space or on reconnect so state survives server restarts.
   * Populates the in-memory cache from Redis so subsequent sync reads work.
   */
  async getStateAsync(spaceId: string): Promise<WatchPartyStateDto | null> {
    const inMemory = this.stateBySpaceId.get(spaceId);
    if (inMemory) return this.toDto(inMemory);

    try {
      const stored = await this.redis.getJson<WatchPartyState>(RedisKeys.watchPartyState(spaceId));
      if (!stored) return null;
      // Warm memory so the next sync call doesn't hit Redis again.
      this.stateBySpaceId.set(spaceId, stored);
      return this.toDto(stored);
    } catch {
      return null;
    }
  }

  /**
   * Freezes the playback position at the drift-adjusted current time and marks the
   * state as paused. Returns the updated state, or null if there was no state.
   * Used when the owner disconnects or leaves so viewers receive a clean pause event.
   */
  pauseAtCurrentPosition(spaceId: string): WatchPartyStateDto | null {
    const state = this.stateBySpaceId.get(spaceId);
    if (!state) return null;

    let currentTime = state.currentTime;
    if (state.isPlaying) {
      const elapsed = (Date.now() - state.updatedAt) / 1000;
      currentTime += elapsed * state.playbackRate;
    }

    const paused: WatchPartyState = {
      ...state,
      isPlaying: false,
      currentTime,
      updatedAt: Date.now(),
    };
    this.stateBySpaceId.set(spaceId, paused);
    void this.redis.setJson(RedisKeys.watchPartyState(spaceId), paused, { ttlSeconds: WP_STATE_TTL_SECONDS }).catch(() => undefined);

    return this.toDto(paused);
  }

  /**
   * Reset the watch-party state for a space when a new video is selected.
   * Writes a fresh paused-at-0 snapshot so late joiners get the correct video
   * (and position) even before the owner's player emits its first control event.
   * If `videoUrl` is empty the state is cleared entirely (equivalent to clearState).
   */
  resetForVideo(spaceId: string, videoUrl: string): void {
    const url = (videoUrl ?? '').trim();
    if (!url) {
      this.clearState(spaceId);
      return;
    }
    const state: WatchPartyState = {
      videoUrl: url,
      isPlaying: false,
      currentTime: 0,
      playbackRate: 1,
      updatedAt: Date.now(),
    };
    this.stateBySpaceId.set(spaceId, state);
    void this.redis.setJson(RedisKeys.watchPartyState(spaceId), state, { ttlSeconds: WP_STATE_TTL_SECONDS }).catch(() => undefined);
  }

  clearState(spaceId: string): void {
    this.stateBySpaceId.delete(spaceId);
    void this.redis.del(RedisKeys.watchPartyState(spaceId)).catch(() => undefined);
  }

  private toDto(state: WatchPartyState): WatchPartyStateDto {
    // Do NOT pre-adjust currentTime here. The client's driftAdjustedTime already
    // computes the elapsed offset using updatedAt, so pre-adjusting server-side
    // with the same updatedAt would double-count the elapsed time and send viewers
    // far past the actual playback position.
    // pauseAtCurrentPosition is the exception — it stores a new frozen snapshot
    // with isPlaying=false, so no client adjustment is needed there.
    return {
      videoUrl: state.videoUrl,
      isPlaying: state.isPlaying,
      currentTime: state.currentTime,
      playbackRate: state.playbackRate,
      updatedAt: state.updatedAt,
    };
  }
}
