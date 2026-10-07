import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppConfigService } from '../app/app-config.service';
import { JOBS } from '../jobs/jobs.constants';
import { JobsService } from '../jobs/jobs.service';
import { EmbeddingsService } from './embeddings.service';

@Injectable()
export class EmbeddingsCron {
  private running = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly jobs: JobsService,
    private readonly embeddings: EmbeddingsService,
  ) {}

  @Cron('*/10 * * * *')
  async tick() {
    if (!this.config.runSchedulers() || !this.embeddings.available()) return;
    try {
      await this.jobs.enqueueCron(JOBS.embeddingsBackfill, {}, 'cron-embeddingsBackfill', {
        attempts: 1,
      });
    } catch {
      // A previous backfill is still queued.
    }
  }

  /** One bounded batch of content that has no vector yet. */
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      await this.embeddings.backfill();
    } finally {
      this.running = false;
    }
  }
}
