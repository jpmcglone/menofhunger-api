import { Injectable, Logger } from '@nestjs/common';
import { MarvinContextCardService } from '../services/marvin-context-card.service';

/**
 * Worker handler for context-card jobs.
 *
 * `marvin.contextCards.refresh` (daily cron): bounded batch of users with new
 * public activity since their last card.
 * `marvin.contextCard.refresh` (one-shot): generate/fold a single user's card,
 * typically after a tool miss so the reply path never waits on the model.
 */
@Injectable()
export class MarvinContextCardsProcessor {
  private readonly logger = new Logger(MarvinContextCardsProcessor.name);

  constructor(private readonly contextCards: MarvinContextCardService) {}

  async process(): Promise<void> {
    const userIds = await this.contextCards.listUsersNeedingCardRefresh(100);
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

  async processOne(userId: string): Promise<void> {
    const id = (userId ?? '').trim();
    if (!id) return;
    await this.contextCards.refreshCardForUser(id);
  }
}
