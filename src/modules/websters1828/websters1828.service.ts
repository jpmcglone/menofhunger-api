import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { wordContentDayKey, nextPublishBoundaryUtcMs } from '../../common/time/eastern-day-key';
import type { WotdLikeBreakdownDto, WotdLikeToggleDto } from '../../common/dto/websters1828.dto';

/** Shape stored in the DailyContentSnapshot JSON blob (no like fields). */
export type Websters1828WordOfDaySnapshot = {
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

/** Full response shape returned to clients (snapshot + live like info). */
export type Websters1828WordOfDay = Websters1828WordOfDaySnapshot & {
  likeCount: number;
  viewerHasLiked: boolean;
};

const WEBSTERS_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
} as const;

@Injectable()
export class Websters1828Service {
  private readonly logger = new Logger(Websters1828Service.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the current word-of-the-day from the DailyContentSnapshot.
   * Returns null if today's snapshot has not been published yet.
   */
  async getWordOfDay(options?: {
    includeDefinition?: boolean;
    userId?: string;
  }): Promise<Websters1828WordOfDay | null> {
    const dayKey = wordContentDayKey(new Date());
    const snap = await this.prisma.dailyContentSnapshot.findUnique({
      where: { dayKey },
      select: { websters1828: true },
    });
    const raw = (snap?.websters1828 ?? null) as Websters1828WordOfDaySnapshot | null;
    if (!raw) return null;
    const { likeCount, viewerHasLiked } = await this.getLikeInfo(raw.word, options?.userId);
    const base = { ...raw, likeCount, viewerHasLiked };
    if (!options?.includeDefinition) {
      return { ...base, definition: null, definitionHtml: null };
    }
    return base;
  }

  // ---------------------------------------------------------------------------
  // Like methods
  // ---------------------------------------------------------------------------

  async toggleLike(userId: string, word: string): Promise<WotdLikeToggleDto> {
    const w = word.toLowerCase().trim();
    const existing = await this.prisma.wotdLike.findUnique({
      where: { word_userId: { word: w, userId } },
    });
    if (existing) {
      await this.prisma.wotdLike.delete({ where: { id: existing.id } });
    } else {
      await this.prisma.wotdLike.create({ data: { word: w, userId } });
    }
    const likeCount = await this.prisma.wotdLike.count({ where: { word: w } });
    return { liked: !existing, likeCount };
  }

  async getLikeBreakdown(word: string): Promise<WotdLikeBreakdownDto> {
    const w = word.toLowerCase().trim();
    const likes = await this.prisma.wotdLike.findMany({
      where: { word: w },
      include: {
        user: { select: { premium: true, premiumPlus: true, verifiedStatus: true } },
      },
    });
    let premium = 0;
    let verified = 0;
    let unverified = 0;
    for (const like of likes) {
      if (like.user.premium || like.user.premiumPlus) premium++;
      else if (like.user.verifiedStatus !== 'none') verified++;
      else unverified++;
    }
    return { premium, verified, unverified, total: likes.length };
  }

  async getLikeInfo(
    word: string,
    userId?: string,
  ): Promise<{ likeCount: number; viewerHasLiked: boolean }> {
    const w = word.toLowerCase().trim();
    const [likeCount, viewerLike] = await Promise.all([
      this.prisma.wotdLike.count({ where: { word: w } }),
      userId
        ? this.prisma.wotdLike.findUnique({ where: { word_userId: { word: w, userId } } })
        : null,
    ]);
    return { likeCount, viewerHasLiked: viewerLike !== null };
  }

  /**
   * Scrape webstersdictionary1828.com and return the current word of the day.
   * Uses the dictionary page as the canonical definition source; homepage block is fallback.
   * Throws if the fetch fails.
   */
  async fetchWordOfDay(): Promise<Websters1828WordOfDaySnapshot> {
    const homepageUrl = 'https://webstersdictionary1828.com/';
    const html = await fetchWithTimeout(homepageUrl, 10_000);

    // Depth-counting extraction of the WordOfTheDay block.
    const blockHtml = extractWordOfTheDayBlock(html);
    let word = extractWordFromBlock(blockHtml);

    if (!word) {
      this.logger.warn('[websters1828] Could not extract word from WOTD block');
      throw new Error('Word of the day is temporarily unavailable.');
    }

    word = decodeBasicEntities(word);
    if (!word) throw new Error('Word of the day is temporarily unavailable.');

    const dictionaryUrl = `https://webstersdictionary1828.com/Dictionary/${encodeURIComponent(word)}`;

    // Dictionary page is the canonical definition source.
    let definition: string | null = null;
    let definitionHtml: string | null = null;
    try {
      const dictHtml = await fetchWithTimeout(dictionaryUrl, 10_000);
      const defResult = extractDictionaryDefinition(dictHtml);
      definition = defResult?.text ?? null;
      definitionHtml = defResult?.html ?? null;
    } catch (err) {
      this.logger.warn(`[websters1828] Dictionary page fetch failed for "${word}": ${String(err)}`);
      // Fall back to homepage block definition.
      const blockDef = extractDefinitionFromBlock(blockHtml);
      definition = blockDef?.text ?? null;
      definitionHtml = blockDef?.html ?? null;
    }

    return {
      word,
      dictionaryUrl,
      sourceUrl: dictionaryUrl,
      definition,
      definitionHtml,
      fetchedAt: new Date().toISOString(),
    };
  }

  /** Cache-Control max-age in seconds (until the next publish boundary). */
  getCacheControlMaxAgeSeconds(now: Date = new Date()): number {
    const nextBoundary = nextPublishBoundaryUtcMs(now);
    return Math.max(60, Math.floor((nextBoundary - now.getTime()) / 1000));
  }
}

// ---------------------------------------------------------------------------
// Scraping helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: WEBSTERS_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Extract the HTML content of the `<div id="WordOfTheDay">` block using
 * a depth-counting scan (div-open / div-close balance) to find the exact
 * closing tag instead of relying on a regex that can over-capture.
 */
function extractWordOfTheDayBlock(html: string): string {
  const tagRe = /<(\/?)div\b/gi;

  // Find the opening <div id="WordOfTheDay"...>.
  const startMatch = html.match(/<div[^>]+id=["']WordOfTheDay["'][^>]*>/i);
  if (!startMatch?.index) return '';

  const openTagEnd = startMatch.index + startMatch[0].length;
  let depth = 1;
  tagRe.lastIndex = openTagEnd;

  let endIndex = -1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[1] === '/') {
      depth--;
      if (depth === 0) {
        // Find the end of the closing </div> tag.
        const closeTagEnd = html.indexOf('>', m.index + m[0].length);
        endIndex = closeTagEnd === -1 ? m.index + m[0].length : closeTagEnd + 1;
        break;
      }
    } else {
      depth++;
    }
  }

  if (endIndex === -1) return html.slice(openTagEnd);
  return html.slice(openTagEnd, endIndex);
}

function extractWordFromBlock(blockHtml: string): string {
  const h3Inner = blockHtml.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '';
  return htmlToText(h3Inner).trim();
}

/**
 * Extract a definition from the homepage WOTD block (fallback when the
 * dictionary page is unavailable). Strips "First Occurrence in the Bible" trailer.
 */
function extractDefinitionFromBlock(blockHtml: string): { text: string; html: string } | null {
  if (!blockHtml) return null;
  // Everything after the closing </h3>.
  const afterHeading = blockHtml.replace(/^[\s\S]*?<\/h3>/i, '');
  if (!afterHeading || afterHeading === blockHtml) return null;
  const cleaned = stripBibleOccurrence(afterHeading);
  const text = htmlToText(cleaned).trim();
  if (!text) return null;
  const safeHtml = sanitizeDefinitionHtml(cleaned);
  return { text, html: safeHtml || `<p>${escapeHtml(text)}</p>` };
}

/**
 * Extract the definition from a full dictionary page.
 * Tries multiple selector patterns in priority order.
 */
function extractDictionaryDefinition(pageHtml: string): { text: string; html: string } | null {
  // Pattern 1: primary column — content between the dictionaryhead and the adjacent mobile column.
  const m1 = pageHtml.match(
    /<h3[^>]*class=["']dictionaryhead["'][^>]*>[\s\S]*?<\/h3>[\s\S]*?<div>([\s\S]*?)<\/div>\s*<div[^>]*class=["']d-md-none["']/i,
  );
  if (m1?.[1]) {
    const cleaned = stripBibleOccurrence(m1[1]);
    const text = htmlToText(cleaned).trim();
    if (text) return { text, html: sanitizeDefinitionHtml(cleaned) || `<p>${escapeHtml(text)}</p>` };
  }

  // Pattern 2: fallback — grab the content column before the sidebar.
  const m2 = pageHtml.match(
    /<h3[^>]*class=["']dictionaryhead["'][^>]*>[\s\S]*?<\/h3>[\s\S]*?<div>([\s\S]*?)<\/div>\s*<\/div>\s*<div[^>]*class=["']col-md-3/i,
  );
  if (m2?.[1]) {
    const cleaned = stripBibleOccurrence(m2[1]);
    const text = htmlToText(cleaned).trim();
    if (text) return { text, html: sanitizeDefinitionHtml(cleaned) || `<p>${escapeHtml(text)}</p>` };
  }

  return null;
}

/** Strip "First Occurrence in the Bible" section and anything after it. */
function stripBibleOccurrence(html: string): string {
  // Remove everything from "First Occurrence in the Bible" onward (case-insensitive).
  return html.replace(/first\s+occurrence\s+in\s+the\s+bible[\s\S]*/gi, '').trim();
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

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

function htmlToText(fragmentHtml: string): string {
  let s = String(fragmentHtml ?? '');

  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');

  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p\s*>/gi, '\n\n');
  s = s.replace(/<p[^>]*>/gi, '');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeBasicEntities(s);
  s = s.replace(/\r\n/g, '\n');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function sanitizeDefinitionHtml(fragmentHtml: string): string {
  let s = String(fragmentHtml ?? '');
  if (!s.trim()) return '';

  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  s = s.replace(/<\s*(div|section|article|header|footer|ul|ol)\b[^>]*>/gi, '<p>');
  s = s.replace(/<\s*\/\s*(div|section|article|header|footer|ul|ol)\s*>/gi, '</p>');
  s = s.replace(/<\s*li\b[^>]*>/gi, '<p>');
  s = s.replace(/<\s*\/\s*li\s*>/gi, '</p>');

  s = s.replace(/<(?!\/?(?:p|br|strong|b|em|i)\b)[^>]*>/gi, '');
  s = s.replace(/<(p|strong|b|em|i)\b[^>]*>/gi, '<$1>');
  s = s.replace(/<br\b[^>]*\/?>/gi, '<br />');

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

