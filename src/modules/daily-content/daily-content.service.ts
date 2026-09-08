import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { Websters1828Service, type Websters1828WordOfDaySnapshot } from '../websters1828/websters1828.service';
import { DAILY_QUOTES, type DailyQuote } from './daily-quotes';
import type { DailyContentTodayDto, DailyQuoteDto } from '../../common/dto/daily-content.dto';
import {
  easternDayKey,
  dayIndexEastern,
  wordContentDayKey,
  quoteContentDayKey,
  nextPublishBoundaryUtcMs,
  nextWordPublishUtcMs,
  nextQuotePublishUtcMs,
  dayKeyToDate,
} from '../../common/time/eastern-day-key';

function pickDailyQuote(quotes: DailyQuote[], now: Date): DailyQuote | null {
  const list = Array.isArray(quotes) ? quotes.filter(Boolean) : [];
  if (list.length === 0) return null;
  // Keep parity with web: +1 so index rotates starting "tomorrow" from day 0.
  const dayIndex = dayIndexEastern(now) + 1;
  const i = ((dayIndex % list.length) + list.length) % list.length;
  return list[i] ?? null;
}

function toIsoOrNull(d: Date | null | undefined): string | null {
  return d instanceof Date ? d.toISOString() : null;
}

function mapQuoteDto(q: unknown): DailyQuoteDto | null {
  const qq = q as DailyQuote | null | undefined;
  if (!qq || typeof qq !== 'object') return null;
  const id = typeof (qq as any).id === 'string' ? (qq as any).id : '';
  const kind = typeof (qq as any).kind === 'string' ? (qq as any).kind : '';
  const author = typeof (qq as any).author === 'string' ? (qq as any).author : '';
  const text = typeof (qq as any).text === 'string' ? (qq as any).text : '';
  if (!id || !kind || !author || !text) return null;
  return {
    id,
    kind: kind as any,
    author,
    reference: typeof (qq as any).reference === 'string' ? (qq as any).reference : null,
    text,
    isParaphrase: Boolean((qq as any).isParaphrase),
    tradition: typeof (qq as any).tradition === 'string' ? (qq as any).tradition : undefined,
    note: typeof (qq as any).note === 'string' ? (qq as any).note : undefined,
    sourceUrl: typeof (qq as any).sourceUrl === 'string' ? (qq as any).sourceUrl : undefined,
  };
}

export type DailyContentItem = 'word' | 'quote';

@Injectable()
export class DailyContentService {
  private readonly logger = new Logger(DailyContentService.name);
  private readonly quotes = DAILY_QUOTES;

  constructor(
    private readonly prisma: PrismaService,
    private readonly websters1828: Websters1828Service,
    private readonly realtime: PresenceRealtimeService,
  ) {}

  /**
   * Pure read: return the currently-active word and quote, each from their
   * respective publish-boundary day key. May return null fields if the
   * relevant snapshot has not been published yet.
   *
   * Does NOT scrape inline. The scheduler publishes missing snapshots.
   */
  async getToday(now: Date = new Date()): Promise<DailyContentTodayDto> {
    const todayKey = easternDayKey(now);
    const wordDayKey = wordContentDayKey(now);
    const quoteDayKey = quoteContentDayKey(now);

    const keys = [...new Set([wordDayKey, quoteDayKey])];
    const snaps = await this.prisma.dailyContentSnapshot.findMany({
      where: { dayKey: { in: keys } },
      select: {
        dayKey: true,
        quote: true,
        quoteRefreshedAt: true,
        websters1828: true,
        websters1828RefreshedAt: true,
      },
    });

    const wordSnap = snaps.find((s) => s.dayKey === wordDayKey);
    const quoteSnap = snaps.find((s) => s.dayKey === quoteDayKey);

    const nextPublishAt = new Date(nextPublishBoundaryUtcMs(now)).toISOString();
    const nextWordPublishAt = new Date(nextWordPublishUtcMs(now)).toISOString();
    const nextQuotePublishAt = new Date(nextQuotePublishUtcMs(now)).toISOString();

    return {
      dayKey: todayKey,
      quote: mapQuoteDto(quoteSnap?.quote ?? null),
      quoteRefreshedAt: toIsoOrNull(quoteSnap?.quoteRefreshedAt ?? null),
      websters1828: (wordSnap?.websters1828 ?? null) as any,
      websters1828RefreshedAt: toIsoOrNull(wordSnap?.websters1828RefreshedAt ?? null),
      nextPublishAt,
      nextWordPublishAt,
      nextQuotePublishAt,
    };
  }

  /**
   * Publish word or quote for a given day key.
   * Uses an atomic claim (updateMany where refreshedAt IS NULL) so concurrent
   * workers can only publish once per day per item. Idempotent: bails if already published.
   * Does NOT send notifications — the fan-out step handles that separately.
   */
  async publish(params: { item: DailyContentItem; dayKey: string }): Promise<{ published: boolean }> {
    const { item, dayKey } = params;

    if (await this.isPublished(item, dayKey)) return { published: false };

    // Ensure the row exists before the atomic final write.
    await this.prisma.dailyContentSnapshot.upsert({
      where: { dayKey },
      create: { dayKey },
      update: {},
    });

    if (item === 'word') {
      return this.publishWord(dayKey);
    }
    return this.publishQuote(dayKey);
  }

  private async publishWord(dayKey: string): Promise<{ published: boolean }> {
    // Fetch the complete definition before exposing either content or a publish timestamp.
    // Competing workers may scrape, but only one can commit. No in-progress sentinel can
    // strand a day after a worker crashes; old sentinels are recoverable too.
    const wotd = await this.websters1828.fetchWordOfDay();
    if (!wotd.word?.trim() || !wotd.definition?.trim()) {
      throw new Error(`[daily-content] Incomplete word snapshot for ${dayKey}`);
    }
    const result = await this.prisma.dailyContentSnapshot.updateMany({
      where: { dayKey, OR: [{ websters1828RefreshedAt: null }, { websters1828RefreshedAt: new Date(1) }] },
      data: { websters1828: wotd as any, websters1828RefreshedAt: new Date() },
    });
    return { published: result.count > 0 };
  }

  private async publishQuote(dayKey: string): Promise<{ published: boolean }> {
    const quote = pickDailyQuote(this.quotes, dayKeyToDate(dayKey));
    if (!quote) throw new Error('[daily-content] No quotes available to publish');
    const result = await this.prisma.dailyContentSnapshot.updateMany({
      where: { dayKey, OR: [{ quoteRefreshedAt: null }, { quoteRefreshedAt: new Date(1) }] },
      data: { quote: quote as any, quoteRefreshedAt: new Date() },
    });
    return { published: result.count > 0 };
  }

  /**
   * Admin-only: force re-publish (overwrites existing snapshot, does NOT re-notify).
   * Used by the admin panel to correct a bad word/quote scrape.
   */
  async republish(params: {
    item?: DailyContentItem;
    dayKey?: string;
    now?: Date;
  }): Promise<DailyContentTodayDto> {
    const now = params?.now ?? new Date();
    const dayKey = params?.dayKey ?? easternDayKey(now);
    const item = params?.item;

    const updated: DailyContentItem[] = [];
    const refreshWord = !item || item === 'word';
    const refreshQuote = !item || item === 'quote';

    if (refreshWord) {
      let wotd: Websters1828WordOfDaySnapshot | null = null;
      try {
        wotd = await this.websters1828.fetchWordOfDay();
      } catch (err) {
        this.logger.warn(`[daily-content] republish word failed: ${(err as Error)?.message ?? String(err)}`);
      }
      if (wotd?.word?.trim() && wotd.definition?.trim()) {
        await this.prisma.dailyContentSnapshot.upsert({
          where: { dayKey },
          create: { dayKey, websters1828: wotd as any, websters1828RefreshedAt: now },
          update: { websters1828: wotd as any, websters1828RefreshedAt: now },
        });
        updated.push('word');
      }
    }

    if (refreshQuote) {
      const dateForDay = dayKeyToDate(dayKey);
      const quote = pickDailyQuote(this.quotes, dateForDay);
      if (quote) {
        await this.prisma.dailyContentSnapshot.upsert({
          where: { dayKey },
          create: { dayKey, quote: quote as any, quoteRefreshedAt: now },
          update: { quote: quote as any, quoteRefreshedAt: now },
        });
        updated.push('quote');
      }
    }

    for (const publishedItem of updated) {
      await this.realtime.emitDailyContentPublished(publishedItem, dayKey);
    }
    return this.getToday(now);
  }

  async isNotified(item: DailyContentItem, dayKey: string): Promise<boolean> {
    const snap = await this.prisma.dailyContentSnapshot.findUnique({
      where: { dayKey }, select: { wordNotifiedAt: true, quoteNotifiedAt: true },
    });
    const timestamp = item === 'word' ? snap?.wordNotifiedAt : snap?.quoteNotifiedAt;
    return timestamp != null && timestamp.getTime() > 1;
  }

  /**
   * Check whether the given item has been published for the given day key.
   * Used by the cron to decide whether to enqueue a publish job.
   */
  async isPublished(item: DailyContentItem, dayKey: string): Promise<boolean> {
    const snap = await this.prisma.dailyContentSnapshot.findUnique({
      where: { dayKey },
      select: { websters1828RefreshedAt: true, quoteRefreshedAt: true },
    });
    if (!snap) return false;
    const ts = item === 'word' ? snap.websters1828RefreshedAt : snap.quoteRefreshedAt;
    // Exclude the sentinel new Date(1) = epoch+1ms, which signals "in-progress".
    return ts !== null && ts.getTime() > 1;
  }
}
