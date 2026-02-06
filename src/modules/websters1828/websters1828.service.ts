import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export type Websters1828WordOfDay = {
  word: string;
  dictionaryUrl: string;
  fetchedAt: string;
};

@Injectable()
export class Websters1828Service {
  // Simple in-memory cache (per API instance).
  private cache: { value: Websters1828WordOfDay; expiresAtMs: number } | null = null;

  async getWordOfDay(opts?: { ttlMs?: number }): Promise<Websters1828WordOfDay> {
    const ttlMs = Math.max(0, Math.floor(opts?.ttlMs ?? 30 * 60 * 1000));
    const now = Date.now();
    if (this.cache && this.cache.expiresAtMs > now) return this.cache.value;

    const next = await this.fetchWordOfDay();
    this.cache = ttlMs > 0 ? { value: next, expiresAtMs: now + ttlMs } : null;
    return next;
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
    } catch (e) {
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

