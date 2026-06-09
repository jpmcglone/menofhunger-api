import { Injectable } from '@nestjs/common';

/**
 * In-memory throttle maps for high-frequency gateway events (typing,
 * reactions). Self-pruning so entries from idle keys don't accumulate.
 */
@Injectable()
export class GatewayThrottleService {
  private readonly typingThrottleByKey = new Map<string, number>();
  private readonly reactionThrottleByKey = new Map<string, number>();
  private typingThrottleLastPruneAtMs = 0;
  private reactionThrottleLastPruneAtMs = 0;
  private readonly typingThrottlePruneEveryMs = 10_000;
  private readonly typingThrottleEntryTtlMs = 1000 * 60 * 2;
  private readonly reactionThrottlePruneEveryMs = 30_000;
  private readonly reactionThrottleEntryTtlMs = 1000 * 60 * 2;

  /** True (and records the hit) when at least minIntervalMs has passed for this typing key. */
  shouldEmitTyping(key: string, minIntervalMs: number): boolean {
    const now = Date.now();
    this.maybePruneTypingThrottle(now);
    const last = this.typingThrottleByKey.get(key) ?? 0;
    if (now - last < minIntervalMs) return false;
    this.typingThrottleByKey.set(key, now);
    return true;
  }

  /** True (and records the hit) when at least minIntervalMs has passed for this reaction key. */
  shouldEmitReaction(key: string, minIntervalMs: number): boolean {
    const now = Date.now();
    this.maybePruneReactionThrottle(now);
    const last = this.reactionThrottleByKey.get(key) ?? 0;
    if (now - last < minIntervalMs) return false;
    this.reactionThrottleByKey.set(key, now);
    return true;
  }

  clearTypingThrottleForUser(userIdRaw: string): void {
    const userId = String(userIdRaw ?? '').trim();
    if (!userId) return;
    const spacesPrefix = `spaces:${userId}:`;
    const msgPrefix = `${userId}:`;
    for (const k of this.typingThrottleByKey.keys()) {
      if (k.startsWith(spacesPrefix) || k.startsWith(msgPrefix)) {
        this.typingThrottleByKey.delete(k);
      }
    }
  }

  private maybePruneTypingThrottle(nowMs: number): void {
    if (nowMs - this.typingThrottleLastPruneAtMs < this.typingThrottlePruneEveryMs) return;
    this.typingThrottleLastPruneAtMs = nowMs;
    const minMs = nowMs - this.typingThrottleEntryTtlMs;
    for (const [k, lastAt] of this.typingThrottleByKey.entries()) {
      if (lastAt < minMs) this.typingThrottleByKey.delete(k);
    }
  }

  private maybePruneReactionThrottle(nowMs: number): void {
    if (nowMs - this.reactionThrottleLastPruneAtMs < this.reactionThrottlePruneEveryMs) return;
    this.reactionThrottleLastPruneAtMs = nowMs;
    const minMs = nowMs - this.reactionThrottleEntryTtlMs;
    for (const [k, lastAt] of this.reactionThrottleByKey.entries()) {
      if (lastAt < minMs) this.reactionThrottleByKey.delete(k);
    }
  }
}
