import { Injectable, Logger } from '@nestjs/common';
import { MarvinThreadSummaryService } from '../services/marvin-thread-summary.service';

export type MarvinSummarizeThreadJobPayload = {
  rootPostId: string;
};

/**
 * Worker handler for `marvin.summarizeThread`.
 *
 * Idempotency: relies on `MarvinThreadSummary.lastMessageIdIncluded`. If no posts
 * have been added since the last successful run, the service returns immediately
 * without an AI call.
 */
@Injectable()
export class MarvinSummarizeThreadProcessor {
  private readonly logger = new Logger(MarvinSummarizeThreadProcessor.name);

  constructor(private readonly summaries: MarvinThreadSummaryService) {}

  async process(payload: MarvinSummarizeThreadJobPayload): Promise<void> {
    if (!payload?.rootPostId) return;
    try {
      await this.summaries.summarizeThread(payload.rootPostId);
    } catch (err) {
      this.logger.warn(
        `[marv] summarizeThread failed root=${payload.rootPostId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
