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
   * ISO timestamp of the next daily-content publish boundary (09:00 ET for word,
   * 09:30 ET for quote). Clients should use this to schedule their next refetch
   * rather than relying on a fixed midnight rollover.
   */
  nextPublishAt: string | null;
};
