import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { TickerService } from './ticker.service';

type SecTickerEntry = {
  cik_str: number;
  ticker: string;
  title: string;
};

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

@Injectable()
export class TickerIngestCron implements OnModuleInit {
  private readonly logger = new Logger(TickerIngestCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly ticker: TickerService,
  ) {}

  /**
   * Auto-seed on first boot when the Ticker table is empty.
   * Runs regardless of RUN_SCHEDULERS so the feature works out of the box
   * on a fresh deploy. The daily cron handles ongoing refresh.
   */
  async onModuleInit() {
    const count = await this.prisma.ticker.count();
    if (count > 0) return;
    void this.runIngest()
      .then(() => this.logger.log('Initial ticker seed complete'))
      .catch((err) => this.logger.warn(`Initial ticker seed failed: ${(err as Error).message}`));
  }

  /** Daily refresh at 6 AM UTC. */
  @Cron('0 6 * * *')
  async scheduledIngest() {
    if (!this.appConfig.runSchedulers()) return;
    await this.runIngest().catch((err) => {
      this.logger.error(`Scheduled ticker ingest failed: ${(err as Error).message}`);
    });
  }

  /** Fetch the SEC company_tickers.json, upsert into the Ticker table, then refresh in-memory set. */
  async runIngest(): Promise<{ upserted: number; skipped: number }> {
    if (this.running) {
      this.logger.warn('Ticker ingest already in progress; skipping');
      return { upserted: 0, skipped: 0 };
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      const url = this.appConfig.secTickersIngestUrl();
      const userAgent = this.appConfig.secTickersUserAgent();

      this.logger.log(`Fetching SEC tickers from ${url}`);
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        throw new Error(`SEC fetch failed: HTTP ${res.status} ${res.statusText}`);
      }

      const json = (await res.json()) as Record<string, SecTickerEntry>;
      const entries = Object.values(json);

      let upserted = 0;
      let skipped = 0;
      for (const batch of chunks(entries, 500)) {
        await Promise.all(
          batch.map(async (e) => {
            const symbol = (e.ticker ?? '').trim().toUpperCase();
            const name = (e.title ?? '').trim();
            if (!symbol || !name) {
              skipped++;
              return;
            }
            await this.prisma.ticker.upsert({
              where: { symbol },
              create: { symbol, name, source: 'sec' },
              update: { name, source: 'sec' },
            });
            upserted++;
          }),
        );
      }

      await this.ticker.refresh();

      const ms = Date.now() - startedAt;
      this.logger.log(`Ticker ingest complete: ${upserted} upserted, ${skipped} skipped (${ms}ms)`);
      return { upserted, skipped };
    } finally {
      this.running = false;
    }
  }
}
