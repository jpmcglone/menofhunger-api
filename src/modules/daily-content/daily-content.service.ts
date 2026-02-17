import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Websters1828Service, type Websters1828WordOfDay } from '../websters1828/websters1828.service';
import { DAILY_QUOTES, type DailyQuote } from './daily-quotes';

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

@Injectable()
export class DailyContentService {
  private readonly logger = new Logger(DailyContentService.name);
  private readonly quotes = DAILY_QUOTES;

  constructor(
    private readonly prisma: PrismaService,
    private readonly websters1828: Websters1828Service,
  ) {}

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

