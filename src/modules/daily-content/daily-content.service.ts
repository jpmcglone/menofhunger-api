import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Websters1828Service, type Websters1828WordOfDay } from '../websters1828/websters1828.service';
import { DAILY_QUOTES, type DailyQuote } from './daily-quotes';
import type { DailyContentTodayDto, DailyQuoteDto } from '../../common/dto/daily-content.dto';

const ET_ZONE = 'America/New_York';

function easternParts(d: Date): { yyyy: number; mm: number; dd: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { yyyy: get('year'), mm: get('month'), dd: get('day'), hour: get('hour'), minute: get('minute') };
}

function easternDayKey(d: Date): string {
  const p = easternParts(d);
  const yyyy = String(p.yyyy).padStart(4, '0');
  const mm = String(p.mm).padStart(2, '0');
  const dd = String(p.dd).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Day number for the calendar day in Eastern Time (quote changes at midnight ET). */
function dayIndexEastern(d: Date): number {
  const p = easternParts(d);
  // Date.UTC expects month 0-11.
  return Math.floor(Date.UTC(p.yyyy, p.mm - 1, p.dd) / 86400000);
}

function pickDailyQuote(quotes: DailyQuote[], now: Date): DailyQuote | null {
  const list = Array.isArray(quotes) ? quotes.filter(Boolean) : [];
  if (list.length === 0) return null;
  // Keep parity with web: +1 so index rotates starting “tomorrow” from day 0.
  const dayIndex = dayIndexEastern(now) + 1;
  const i = ((dayIndex % list.length) + list.length) % list.length;
  return list[i] ?? null;
}

function safeMinuteOfDayEt(d: Date): number {
  const p = easternParts(d);
  return p.hour * 60 + p.minute;
}

function easternYmd(d: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = Number(parts.find((p) => p.type === 'year')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'month')?.value ?? 1);
  const dd = Number(parts.find((p) => p.type === 'day')?.value ?? 1);
  return { y, m, d: dd };
}

function easternYmdHms(d: Date): { y: number; m: number; d: number; hh: number; mm: number; ss: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute'), ss: get('second') };
}

/**
 * UTC timestamp for the next midnight in Eastern Time.
 * (Small UTC search window; avoids pulling a timezone library.)
 */
function nextEasternMidnightUtcMs(now: Date): number {
  const tomorrowEt = easternYmd(new Date(now.getTime() + 36 * 60 * 60 * 1000));
  for (let utcHour = 0; utcHour <= 12; utcHour++) {
    const cand = new Date(Date.UTC(tomorrowEt.y, tomorrowEt.m - 1, tomorrowEt.d, utcHour, 0, 0));
    const p = easternYmdHms(cand);
    if (p.y === tomorrowEt.y && p.m === tomorrowEt.m && p.d === tomorrowEt.d && p.hh === 0 && p.mm === 0) {
      return cand.getTime();
    }
  }
  return now.getTime() + 24 * 60 * 60 * 1000;
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

@Injectable()
export class DailyContentService {
  private readonly logger = new Logger(DailyContentService.name);
  private readonly quotes = DAILY_QUOTES;

  constructor(
    private readonly prisma: PrismaService,
    private readonly websters1828: Websters1828Service,
  ) {}

  /** Cache-Control max-age in seconds (until next midnight ET, with a short early-morning window for healing). */
  getCacheControlMaxAgeSeconds(now: Date = new Date()): number {
    const expiresAtMs = nextEasternMidnightUtcMs(now);
    const secondsUntilMidnight = Math.max(0, Math.floor((expiresAtMs - now.getTime()) / 1000));
    const et = easternYmdHms(now);
    if (et.hh < 9) return Math.min(300, secondsUntilMidnight);
    return secondsUntilMidnight;
  }

  async getToday(now: Date = new Date()): Promise<DailyContentTodayDto> {
    const dayKey = easternDayKey(now);
    // Ensure the snapshot exists (best-effort; cron normally maintains it).
    try {
      await this.refreshForTodayIfNeeded(now);
    } catch (err) {
      this.logger.warn(`[daily-content] refreshForTodayIfNeeded failed: ${(err as Error)?.message ?? String(err)}`);
    }
    const snap = await this.prisma.dailyContentSnapshot.findUnique({
      where: { dayKey },
      select: {
        dayKey: true,
        quote: true,
        quoteRefreshedAt: true,
        websters1828: true,
        websters1828RefreshedAt: true,
        websters1828RecheckedAt: true,
      },
    });

    return {
      dayKey,
      quote: mapQuoteDto(snap?.quote ?? null),
      quoteRefreshedAt: toIsoOrNull(snap?.quoteRefreshedAt ?? null),
      websters1828: (snap?.websters1828 ?? null) as any,
      websters1828RefreshedAt: toIsoOrNull(snap?.websters1828RefreshedAt ?? null),
      websters1828RecheckedAt: toIsoOrNull(snap?.websters1828RecheckedAt ?? null),
    };
  }

  async forceRefreshToday(params?: { quote?: boolean; websters1828?: boolean; now?: Date }): Promise<DailyContentTodayDto> {
    const now = params?.now ?? new Date();
    const dayKey = easternDayKey(now);
    const refreshQuote = params?.quote !== false;
    const refreshWotd = params?.websters1828 !== false;

    const quote = refreshQuote ? pickDailyQuote(this.quotes, now) : null;
    let wotd: Websters1828WordOfDay | null = null;
    if (refreshWotd) {
      try {
        wotd = await this.websters1828.getWordOfDay({ includeDefinition: true, forceRefresh: true });
      } catch (err) {
        this.logger.warn(`[daily-content] force refresh wotd failed: ${(err as Error)?.message ?? String(err)}`);
        wotd = null;
      }
    }

    await this.prisma.dailyContentSnapshot.upsert({
      where: { dayKey },
      create: {
        dayKey,
        ...(quote ? { quote: quote as any, quoteRefreshedAt: now } : {}),
        ...(wotd ? { websters1828: wotd as any, websters1828RefreshedAt: now, websters1828RecheckedAt: now } : {}),
      },
      update: {
        ...(quote ? { quote: quote as any, quoteRefreshedAt: now } : {}),
        ...(wotd ? { websters1828: wotd as any, websters1828RefreshedAt: now, websters1828RecheckedAt: now } : {}),
      },
    });

    return await this.getToday(now);
  }

  async refreshForTodayIfNeeded(now: Date = new Date()): Promise<void> {
    const dayKey = easternDayKey(now);
    const minuteOfDay = safeMinuteOfDayEt(now);

    const snap = await this.prisma.dailyContentSnapshot.findUnique({
      where: { dayKey },
      select: {
        dayKey: true,
        quoteRefreshedAt: true,
        websters1828RefreshedAt: true,
        websters1828RecheckedAt: true,
      },
    });

    const shouldEnsureBase = !snap || !snap.quoteRefreshedAt || !snap.websters1828RefreshedAt;
    const shouldRecheckAt8am = minuteOfDay >= 8 * 60 && Boolean(snap?.websters1828RecheckedAt == null);

    if (!shouldEnsureBase && !shouldRecheckAt8am) return;

    const quote = pickDailyQuote(this.quotes, now);

    let wotd: Websters1828WordOfDay | null = null;
    try {
      wotd = await this.websters1828.getWordOfDay({ includeDefinition: true, forceRefresh: true });
    } catch (err) {
      this.logger.warn(`[daily-content] wotd fetch failed: ${(err as Error)?.message ?? String(err)}`);
    }

    const quoteRefreshedAt = quote ? now : snap?.quoteRefreshedAt ?? null;
    const websters1828RefreshedAt = wotd ? (snap?.websters1828RefreshedAt ? snap.websters1828RefreshedAt : now) : snap?.websters1828RefreshedAt ?? null;
    const websters1828RecheckedAt = wotd && shouldRecheckAt8am ? now : snap?.websters1828RecheckedAt ?? null;

    await this.prisma.dailyContentSnapshot.upsert({
      where: { dayKey },
      create: {
        dayKey,
        quote: quote as any,
        quoteRefreshedAt: quote ? now : null,
        websters1828: wotd as any,
        websters1828RefreshedAt: wotd ? now : null,
        websters1828RecheckedAt: wotd && shouldRecheckAt8am ? now : null,
      },
      update: {
        ...(quote ? { quote: quote as any, quoteRefreshedAt } : {}),
        ...(wotd
          ? {
              websters1828: wotd as any,
              ...(websters1828RefreshedAt ? { websters1828RefreshedAt } : {}),
              ...(websters1828RecheckedAt ? { websters1828RecheckedAt } : {}),
            }
          : {}),
      },
    });
  }
}

