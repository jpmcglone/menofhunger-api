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
  websters1828RecheckedAt: string | null;
};

