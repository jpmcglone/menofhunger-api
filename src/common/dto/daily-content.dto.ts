import type { Websters1828WordOfDayDto } from './websters1828.dto';

export type DailyQuoteKindDto = 'scripture' | 'quote' | 'paraphrase';

export type DailyQuoteDto = {
  id: string;
  kind: DailyQuoteKindDto;
  author: string;
  reference: string | null;
  text: string;
  isParaphrase: boolean;
  tradition?: string;
  note?: string;
  sourceUrl?: string;
};

export type DailyContentTodayDto = {
  /** Eastern Time day key (YYYY-MM-DD). */
  dayKey: string;
  quote: DailyQuoteDto | null;
  quoteRefreshedAt: string | null;
  websters1828: Websters1828WordOfDayDto | null;
  websters1828RefreshedAt: string | null;
  /**
   * ISO timestamp of the next daily-content publish boundary (whichever of
   * 09:00 ET word or 09:30 ET quote comes first). Use `nextWordPublishAt` /
   * `nextQuotePublishAt` for per-item countdowns.
   */
  nextPublishAt: string | null;
  /** ISO timestamp of when today's word-of-the-day will (or did) publish: 09:00 ET. */
  nextWordPublishAt: string | null;
  /** ISO timestamp of when today's quote-of-the-day will (or did) publish: 09:30 ET. */
  nextQuotePublishAt: string | null;
};
