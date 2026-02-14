import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export type Websters1828WordOfDay = {
  word: string;
  dictionaryUrl: string;
  /** Parsed definition text (paragraphs separated by blank lines). */
  definition: string | null;
  /** Sanitized HTML preserving source emphasis (bold/italic/paragraph breaks). */
  definitionHtml: string | null;
  /** Canonical source URL for the definition. */
  sourceUrl: string;
  fetchedAt: string;
};

const ET_ZONE = 'America/New_York';
const WEBSTERS_HEADERS = {
  // Some pages appear to be sensitive to default Node fetch headers.
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
} as const;

@Injectable()
export class Websters1828Service {
  // Simple in-memory cache (per API instance).
  private cache:
    | {
        value: Omit<Websters1828WordOfDay, 'definition' | 'definitionHtml'> & {
          /** Undefined means “not fetched yet”. */
          definition?: string | null;
          /** Undefined means “not fetched yet”. */
          definitionHtml?: string | null;
          /** Parsed from the homepage WOTD block; used as a fallback. */
          homepageDefinition?: string | null;
          /** Parsed HTML from homepage WOTD block; used as a fallback. */
          homepageDefinitionHtml?: string | null;
        };
        dayKey: string;
        expiresAtMs: number;
      }
    | null = null;

  /**
   * Cache rolls over at midnight ET so it aligns with other daily content.
   * Note: This is an in-memory cache (per API instance).
   */
  async getWordOfDay(options?: { includeDefinition?: boolean }): Promise<Websters1828WordOfDay> {
    const includeDefinition = options?.includeDefinition === true;
    const now = Date.now();
    const dayKey = easternDateKey(new Date(now));
    const expiresAtMs = nextEasternMidnightUtcMs(new Date(now));

    if (!this.cache || this.cache.dayKey !== dayKey || this.cache.expiresAtMs <= now) {
      const next = await this.fetchWordOfDayBase();
      this.cache = { value: next, dayKey, expiresAtMs };
    }

    if (includeDefinition) {
      // Populate definition lazily when requested.
      if (this.cache.value.definition === undefined || this.cache.value.definitionHtml === undefined) {
        if (this.cache.value.homepageDefinition || this.cache.value.homepageDefinitionHtml) {
          this.cache.value.definition = this.cache.value.homepageDefinition ?? null;
          this.cache.value.definitionHtml = this.cache.value.homepageDefinitionHtml ?? null;
        } else {
          const fetched = await this.fetchDefinitionBestEffort(this.cache.value.dictionaryUrl).catch(() => null);
          this.cache.value.definition = fetched?.text ?? null;
          this.cache.value.definitionHtml = fetched?.html ?? null;
        }
      } else if (!this.cache.value.definition && !this.cache.value.definitionHtml) {
        // Heal parse/network misses on subsequent requests the same day.
        const fetched = await this.fetchDefinitionBestEffort(this.cache.value.dictionaryUrl).catch(() => null);
        if (fetched) {
          this.cache.value.definition = fetched.text;
          this.cache.value.definitionHtml = fetched.html;
        }
      }
    }

    return {
      word: this.cache.value.word,
      dictionaryUrl: this.cache.value.dictionaryUrl,
      sourceUrl: this.cache.value.sourceUrl,
      fetchedAt: this.cache.value.fetchedAt,
      definition: includeDefinition ? (this.cache.value.definition ?? null) : null,
      definitionHtml: includeDefinition ? (this.cache.value.definitionHtml ?? null) : null,
    };
  }

  /** Cache-Control max-age in seconds (until next midnight ET). */
  getCacheControlMaxAgeSeconds(now: Date = new Date()): number {
    const expiresAtMs = nextEasternMidnightUtcMs(now);
    return Math.max(0, Math.floor((expiresAtMs - now.getTime()) / 1000));
  }

  private async fetchWordOfDayBase(): Promise<
    Omit<Websters1828WordOfDay, 'definition' | 'definitionHtml'> & {
      homepageDefinition: string | null;
      homepageDefinitionHtml: string | null;
    }
  > {
    const url = 'https://webstersdictionary1828.com/';
    let html: string;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(url, { signal: controller.signal, headers: WEBSTERS_HEADERS });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        html = await res.text();
      } finally {
        clearTimeout(t);
      }
    } catch {
      throw new ServiceUnavailableException('Word of the day is temporarily unavailable.');
    }

    // Primary parse: <div id="WordOfTheDay" ...><h3>Word</h3>...</div>
    const blockHtml = extractWordOfTheDayBlockHtml(html);
    let word = extractWordFromWotdBlock(blockHtml);

    // Fallback: older/alternate markup.
    if (!word) {
      const m = html.match(/Word of the Day[\s\S]*?###\s+([^\n\r#]+)/i);
      word = (m?.[1] ?? '').trim();
    }

    word = decodeBasicEntities(word);
    if (!word) throw new ServiceUnavailableException('Word of the day is temporarily unavailable.');

    const dictionaryUrl = `https://webstersdictionary1828.com/Dictionary/${encodeURIComponent(word)}`;
    const homepageDefinition = extractDefinitionFromWotdBlock(blockHtml);

    return {
      word,
      dictionaryUrl,
      sourceUrl: dictionaryUrl,
      homepageDefinition: homepageDefinition.text,
      homepageDefinitionHtml: homepageDefinition.html,
      fetchedAt: new Date().toISOString(),
    };
  }

  private async fetchDefinitionBestEffort(dictionaryUrl: string): Promise<{ text: string; html: string } | null> {
    const url = (dictionaryUrl ?? '').trim();
    if (!url) return null;
    let html: string;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(url, { signal: controller.signal, headers: WEBSTERS_HEADERS });
        if (!res.ok) return null;
        html = await res.text();
      } finally {
        clearTimeout(t);
      }
    } catch {
      return null;
    }

    const defHtml = extractDefinitionHtml(html);
    if (!defHtml) return null;
    const text = htmlToText(defHtml);
    const cleanText = text.trim();
    if (!cleanText) return null;
    const safeHtml = sanitizeDefinitionHtml(defHtml);
    return {
      text: cleanText,
      html: safeHtml || `<p>${escapeHtml(cleanText)}</p>`,
    };
  }
}

function decodeBasicEntities(s: string): string {
  return (s ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function extractDefinitionHtml(pageHtml: string): string | null {
  const html = String(pageHtml ?? '');

  // Common page shape includes:
  // <h3 class="dictionaryhead">Word</h3> ... <div>...definition...</div> <div class="d-md-none">...
  const m1 = html.match(
    /<h3[^>]*class=["']dictionaryhead["'][^>]*>[\s\S]*?<\/h3>[\s\S]*?<div>([\s\S]*?)<\/div>\s*<div[^>]*class=["']d-md-none["']/i,
  );
  if (m1?.[1]) return m1[1];

  // Fallback: grab the first <div> after the dictionaryhead, bounded by the next column or footer.
  const m2 = html.match(
    /<h3[^>]*class=["']dictionaryhead["'][^>]*>[\s\S]*?<\/h3>[\s\S]*?<div>([\s\S]*?)<\/div>\s*<\/div>\s*<div[^>]*class=["']col-md-3/i,
  );
  if (m2?.[1]) return m2[1];

  return null;
}

function extractWordOfTheDayBlockHtml(homepageHtml: string): string {
  const html = String(homepageHtml ?? '');
  const block = html.match(/<div[^>]+id=["']WordOfTheDay["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)?.[1];
  return block ?? '';
}

function extractWordFromWotdBlock(blockHtml: string): string {
  const html = String(blockHtml ?? '');
  const h3Inner = html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '';
  const cleaned = htmlToText(h3Inner);
  return cleaned.trim();
}

function extractDefinitionFromWotdBlock(blockHtml: string): { text: string | null; html: string | null } {
  const html = String(blockHtml ?? '');
  if (!html) return { text: null, html: null };
  const afterHeading = html.replace(/^[\s\S]*?<\/h3>/i, '');
  if (!afterHeading || afterHeading === html) return { text: null, html: null };
  const text = htmlToText(afterHeading);
  const cleanText = text.trim();
  if (!cleanText) return { text: null, html: null };
  const safeHtml = sanitizeDefinitionHtml(afterHeading);
  return {
    text: cleanText,
    html: safeHtml || `<p>${escapeHtml(cleanText)}</p>`,
  };
}

function htmlToText(fragmentHtml: string): string {
  let s = String(fragmentHtml ?? '');

  // Remove scripts/styles just in case.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');

  // Line breaks / paragraphing.
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p\s*>/gi, '\n\n');
  s = s.replace(/<p[^>]*>/gi, '');

  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, '');

  // Decode basic entities.
  s = decodeBasicEntities(s);

  // Normalize whitespace.
  s = s.replace(/\r\n/g, '\n');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function sanitizeDefinitionHtml(fragmentHtml: string): string {
  let s = String(fragmentHtml ?? '');
  if (!s.trim()) return '';

  // Strip active content and comments.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // Normalize common block wrappers to paragraphs.
  s = s.replace(/<\s*(div|section|article|header|footer|ul|ol)\b[^>]*>/gi, '<p>');
  s = s.replace(/<\s*\/\s*(div|section|article|header|footer|ul|ol)\s*>/gi, '</p>');
  s = s.replace(/<\s*li\b[^>]*>/gi, '<p>');
  s = s.replace(/<\s*\/\s*li\s*>/gi, '</p>');

  // Keep only a minimal, safe subset used by the source styling.
  s = s.replace(/<(?!\/?(?:p|br|strong|b|em|i)\b)[^>]*>/gi, '');

  // Remove all attributes from allowed tags.
  s = s.replace(/<(p|strong|b|em|i)\b[^>]*>/gi, '<$1>');
  s = s.replace(/<br\b[^>]*\/?>/gi, '<br />');

  // Tighten spacing.
  s = s.replace(/\s*\n+\s*/g, ' ');
  s = s.replace(/<p>\s*<\/p>/gi, '');
  s = s.replace(/(?:\s*<br \/>\s*){3,}/gi, '<br /><br />');
  s = s.replace(/(<\/p>)\s*(<p>)/gi, '$1$2');

  return s.trim();
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
