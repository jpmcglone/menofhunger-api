import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { SpacesPresenceService } from './spaces-presence.service';
import { SpacesService } from './spaces.service';

const EMPTY_LOBBY_DEACTIVATE_AFTER_MS = 5 * 60 * 1000;

/**
 * Safety net for abandoned live spaces when owner-leave cleanup was missed
 * (process crash, network drop before unregister, etc.).
 *
 * Uses this instance's empty-since stamp + lobby membership. Primary path is
 * still immediate deactivate when the last owner socket leaves.
 */
@Injectable()
export class SpacesIdleCleanupCron {
  private readonly logger = new Logger(SpacesIdleCleanupCron.name);
  private running = false;

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly spaces: SpacesService,
    private readonly spacesPresence: SpacesPresenceService,
  ) {}

  @Interval(120_000)
  async sweepAbandonedLiveSpaces(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    if (this.running) return;
    this.running = true;
    try {
      const active = await this.prisma.space.findMany({
        where: { isActive: true },
        select: { id: true },
        take: 500,
      });
      if (active.length === 0) return;

      const now = Date.now();
      let closed = 0;
      for (const row of active) {
        const emptySince = this.spacesPresence.ensureEmptyStamp(row.id);
        if (emptySince == null) continue;
        if (now - emptySince < EMPTY_LOBBY_DEACTIVATE_AFTER_MS) continue;
        const did = await this.spaces.deactivateIfActive(row.id);
        if (did) closed += 1;
      }
      if (closed > 0) {
        this.logger.log(`Closed ${closed} abandoned live space(s) after empty lobby timeout`);
      }
    } catch (err) {
      this.logger.warn(
        `Abandoned space sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
