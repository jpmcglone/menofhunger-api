import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppConfigService } from '../app/app-config.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { CallsService } from './calls.service';
import { CALL_SWEEP_INTERVAL_MS } from './calls.constants';

/**
 * Guarantees the invariant "a call never outlives its participants": every seat whose socket
 * is provably gone is put into reconnecting → removed after the grace, and a session with no
 * seats left is ended. The event-driven paths (socket disconnect + BullMQ timers) do this
 * within seconds in the normal case; the sweep exists for the cases they can't see — a
 * process that died before `handleDisconnect` ran, or a delayed job that was never consumed.
 *
 * Runs on any process with schedulers enabled; a short Redis lock keeps one runner per tick.
 * Everything it does re-reads Redis under the per-conversation lock, so overlap is harmless.
 */
@Injectable()
export class CallsSweepCron {
  private readonly logger = new Logger(CallsSweepCron.name);
  private running = false;

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly redis: RedisService,
    private readonly calls: CallsService,
  ) {}

  @Interval(CALL_SWEEP_INTERVAL_MS)
  async sweep(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    if (this.running) return;
    this.running = true;
    try {
      const acquired = await this.redis.setString(RedisKeys.callsSweepLock(), '1', {
        ttlMs: Math.max(1_000, CALL_SWEEP_INTERVAL_MS - 2_000),
        onlyIfAbsent: true,
      });
      if (!acquired) return;
      const actions = await this.calls.sweepStaleSessions();
      if (actions > 0) this.logger.log(`Call liveness sweep took ${actions} corrective action(s)`);
    } catch (err) {
      this.logger.warn(`Call liveness sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
