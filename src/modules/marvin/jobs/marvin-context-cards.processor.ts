import { Injectable, Logger } from '@nestjs/common';
import { MarvinContextCardService } from '../services/marvin-context-card.service';

/**
 * Worker handler for `marvin.contextCards.refresh`. Consumes the daily cron
 * tick from `MarvinContextCardsCron` and refreshes a bounded batch of stale
 * context cards. We deliberately do NOT process all users in one job:
 *  - keeps OpenAI spend predictable (admin can enlarge the batch via env later)
 *  - keeps each BullMQ job below a reasonable wall-clock limit
 *  - lets us back off cleanly if the AI provider is rate-limited
 */
@Injectable()
export class MarvinContextCardsProcessor {
  private readonly logger = new Logger(MarvinContextCardsProcessor.name);

  constructor(private readonly contextCards: MarvinContextCardService) {}

  async process(): Promise<void> {
    const userIds = await this.contextCards.listStaleCardUserIds(30, 100);
    if (!userIds.length) {
      this.logger.debug('[marv] context-cards refresh: nothing to do');
      return;
    }
    this.logger.log(`[marv] context-cards refresh: ${userIds.length} users`);
    let ok = 0;
    let failed = 0;
    for (const id of userIds) {
      try {
        await this.contextCards.refreshCardForUser(id);
        ok += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn(
          `[marv] context-card refresh failed user=${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.log(`[marv] context-cards refresh done: ok=${ok} failed=${failed}`);
  }
}
