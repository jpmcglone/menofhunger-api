import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export type Websters1828WordOfDay = {
  word: string;
  dictionaryUrl: string;
  fetchedAt: string;
};

const ET_ZONE = 'America/New_York';

@Injectable()
export class Websters1828Service {
  // Simple in-memory cache (per API instance).
  private cache:
    | { value: Websters1828WordOfDay; dayKey: string; expiresAtMs: number }
    | null = null;

  /**
   * Cache rolls over at midnight ET so it aligns with other daily content.
   * Note: This is an in-memory cache (per API instance).
   */
  async getWordOfDay(): Promise<Websters1828WordOfDay> {
    const now = Date.now();
    const dayKey = easternDateKey(new Date(now));
    const expiresAtMs = nextEasternMidnightUtcMs(new Date(now));
    if (this.cache && this.cache.dayKey === dayKey && this.cache.expiresAtMs > now) {
      return this.cache.value;
    }

    const next = await this.fetchWordOfDay();
    this.cache = { value: next, dayKey, expiresAtMs };
    return next;
  }

  /** Cache-Control max-age in seconds (until next midnight ET). */
  getCacheControlMaxAgeSeconds(now: Date = new Date()): number {
    const expiresAtMs = nextEasternMidnightUtcMs(now);
    return Math.max(0, Math.floor((expiresAtMs - now.getTime()) / 1000));
  }

  private async fetchWordOfDay(): Promise<Websters1828WordOfDay> {
    const url = 'https://webstersdictionary1828.com/';
    let html: string;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        html = await res.text();
      } finally {
        clearTimeout(t);
      }
    } catch {
      throw new ServiceUnavailableException('Word of the day is temporarily unavailable.');
    }

    // Primary parse: <div id="WordOfTheDay" ...><h3>Lucre</h3>...</div>
    const blockMatch = html.match(
      /<div[^>]+id=["']WordOfTheDay["'][^>]*>[\s\S]*?<h3>([^<]+)<\/h3>/i,
    );
    let word = (blockMatch?.[1] ?? '').trim();

    // Fallback: older/alternate markup.
    if (!word) {
      const m = html.match(/Word of the Day[\s\S]*?###\s+([^\n\r#]+)/i);
      word = (m?.[1] ?? '').trim();
    }

    word = decodeBasicEntities(word);
    if (!word) throw new ServiceUnavailableException('Word of the day is temporarily unavailable.');

    return {
      word,
      dictionaryUrl: `https://webstersdictionary1828.com/Dictionary/${encodeURIComponent(word)}`,
      fetchedAt: new Date().toISOString(),
    };
  }
}

function decodeBasicEntities(s: string): string {
  return (s ?? '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

function easternDateKey(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}function easternYmd(d: Date): { y: number; m: number; d: number } {
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
  const y = Number(parts.find((p) => p.type === 'year')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'month')?.value ?? 1);
  const dd = Number(parts.find((p) => p.type === 'day')?.value ?? 1);
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const ss = Number(parts.find((p) => p.type === 'second')?.value ?? 0);
  return { y, m, d: dd, hh, mm, ss };
}

/**
 * UTC timestamp for the next midnight in Eastern Time.
 *
 * We avoid extra deps by searching a small UTC hour window (ET is UTC-4/UTC-5).
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
  // Fallback: ~24h from now (should never happen).
  return now.getTime() + 24 * 60 * 60 * 1000;
}
