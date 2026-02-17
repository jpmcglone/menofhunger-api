import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';
import { RedisKeys } from './redis-keys';

@Injectable()
export class CacheInvalidationService {
  private readonly logger = new Logger(CacheInvalidationService.name);

  constructor(private readonly redis: RedisService) {}

  private normalizeTopics(topics: string[]): string[] {
    // Canonicalize so callers can pass mixed casing/spacing without causing redundant bumps.
    return Array.from(new Set((topics ?? []).map((t) => String(t ?? '').trim().toLowerCase()).filter(Boolean)));
  }

  private async readVersionOrDefault(key: string, fallback: number = 1): Promise<number> {
    try {
      const raw = await this.redis.getString(key);
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
    } catch (err) {
      this.logger.debug(`Failed to read version ${key}: ${err}`);
      return fallback;
    }
  }

  async feedGlobalVersion(): Promise<number> {
    return await this.readVersionOrDefault(RedisKeys.verFeedGlobal(), 1);
  }

  async searchGlobalVersion(): Promise<number> {
    return await this.readVersionOrDefault(RedisKeys.verSearchGlobal(), 1);
  }

  async topicVersion(topic: string): Promise<number> {
    return await this.readVersionOrDefault(RedisKeys.verTopic(topic), 1);
  }

  async profileVersion(userId: string): Promise<number> {
    return await this.readVersionOrDefault(RedisKeys.verProfile(userId), 1);
  }

  async bumpFeedGlobal(): Promise<number> {
    try {
      return await this.redis.raw().incr(RedisKeys.verFeedGlobal());
    } catch (err) {
      this.logger.warn(`Failed to bump feed version: ${err}`);
      return await this.feedGlobalVersion();
    }
  }

  async bumpSearchGlobal(): Promise<number> {
    try {
      return await this.redis.raw().incr(RedisKeys.verSearchGlobal());
    } catch (err) {
      this.logger.warn(`Failed to bump search version: ${err}`);
      return await this.searchGlobalVersion();
    }
  }

  async bumpTopic(topic: string): Promise<number> {
    try {
      return await this.redis.raw().incr(RedisKeys.verTopic(topic));
    } catch (err) {
      this.logger.warn(`Failed to bump topic version topic=${topic}: ${err}`);
      return await this.topicVersion(topic);
    }
  }

  async bumpProfile(userId: string): Promise<number> {
    const uid = String(userId ?? '').trim();
    if (!uid) return 0;
    try {
      return await this.redis.raw().incr(RedisKeys.verProfile(uid));
    } catch (err) {
      this.logger.warn(`Failed to bump profile version userId=${uid}: ${err}`);
      return await this.profileVersion(uid);
    }
  }

  /**
   * Post writes can affect:
   * - feeds (new/popular/featured)
   * - search posts
   * - topic post lists
   *
   * We use version bumps for instant invalidation without pattern deletes.
   */
  async bumpForPostWrite(params: { topics: string[] }): Promise<void> {
    const topics = this.normalizeTopics(params.topics ?? []);
    await Promise.allSettled([
      this.bumpFeedGlobal(),
      this.bumpSearchGlobal(),
      ...topics.map((t) => this.bumpTopic(t)),
    ]).catch(() => undefined);
  }

  async deleteSessionUser(tokenHash: string): Promise<void> {
    const th = String(tokenHash ?? '').trim();
    if (!th) return;
    try {
      await this.redis.del(RedisKeys.sessionUser(th));
    } catch {
      // Best-effort
    }
  }
}

