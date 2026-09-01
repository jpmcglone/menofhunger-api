import { HASHTAG_IN_TEXT_DISPLAY_RE } from '../../common/hashtags/hashtag-regex';
import { CASHTAG_IN_TEXT_DISPLAY_RE } from '../../common/cashtags/cashtag-regex';
import {
  SCRIPTURE_IN_TEXT_RE,
  acceptChapterOnly,
  formatScriptureReference,
  lookupBook,
  parseVerseSpec,
} from '../../common/scripture/scripture-reference';
import { EMAIL, EMAIL_CLASS, escapeHtml } from './templates/moh-email';

/** Same contract as www `MENTION_IN_TEXT_DISPLAY_RE`. */
const MENTION_IN_TEXT_DISPLAY_RE = /(?<![a-zA-Z0-9_])@([A-Za-z][A-Za-z0-9_]{0,14})/g;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`]+/gi;

export type EmailRichSpanKind = 'url' | 'mention' | 'hashtag' | 'cashtag' | 'scripture';

type Span = {
  start: number;
  end: number;
  href: string;
  kind: EmailRichSpanKind;
};

export function siteOriginFromUrl(url: string | null | undefined): string {
  const raw = (url ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

function overlaps(claimed: Array<[number, number]>, start: number, end: number): boolean {
  return claimed.some(([a, b]) => start < b && end > a);
}

function trimUrlMatch(raw: string): string {
  return raw.replace(/[),.]+$/g, '');
}

function collectSpans(text: string, siteUrl: string): Span[] {
  const base = siteUrl.replace(/\/$/, '');
  const claimed: Array<[number, number]> = [];
  const spans: Span[] = [];

  const add = (start: number, end: number, href: string, kind: EmailRichSpanKind) => {
    if (start < 0 || end <= start) return;
    if (overlaps(claimed, start, end)) return;
    claimed.push([start, end]);
    spans.push({ start, end, href, kind });
  };

  const urlRe = new RegExp(URL_IN_TEXT_RE.source, URL_IN_TEXT_RE.flags);
  for (const m of text.matchAll(urlRe)) {
    const raw = trimUrlMatch(m[0] ?? '');
    const start = m.index ?? -1;
    if (!raw || start < 0) continue;
    add(start, start + raw.length, raw, 'url');
  }

  const mentionRe = new RegExp(MENTION_IN_TEXT_DISPLAY_RE.source, MENTION_IN_TEXT_DISPLAY_RE.flags);
  for (const m of text.matchAll(mentionRe)) {
    const username = m[1] ?? '';
    const start = m.index ?? -1;
    if (!username || start < 0) continue;
    add(start, start + (m[0] ?? '').length, `${base}/u/${encodeURIComponent(username)}`, 'mention');
  }

  const hashtagRe = new RegExp(HASHTAG_IN_TEXT_DISPLAY_RE.source, 'g');
  for (const m of text.matchAll(hashtagRe)) {
    const tag = (m[1] ?? '').trim();
    const start = m.index ?? -1;
    if (!tag || start < 0) continue;
    add(start, start + (m[0] ?? '').length, `${base}/explore?q=${encodeURIComponent(`#${tag}`)}`, 'hashtag');
  }

  const cashtagRe = new RegExp(CASHTAG_IN_TEXT_DISPLAY_RE.source, 'g');
  for (const m of text.matchAll(cashtagRe)) {
    const symbol = (m[1] ?? '').trim().toUpperCase();
    const start = m.index ?? -1;
    if (!symbol || start < 0) continue;
    add(start, start + (m[0] ?? '').length, `${base}/explore?q=${encodeURIComponent(`$${symbol}`)}`, 'cashtag');
  }

  const scriptureRe = new RegExp(SCRIPTURE_IN_TEXT_RE.source, SCRIPTURE_IN_TEXT_RE.flags);
  for (const m of text.matchAll(scriptureRe)) {
    const entry = lookupBook(m[1] ?? '');
    if (!entry) continue;
    const raw = m[0] ?? '';
    const start = m.index ?? -1;
    if (start < 0) continue;
    const spansSpec = parseVerseSpec(m[3]);
    if (!spansSpec && !acceptChapterOnly(m[1] ?? '', entry.name, text, start, start + raw.length)) {
      continue;
    }
    const chapter = parseInt(m[2] ?? '', 10);
    if (!Number.isFinite(chapter)) continue;
    const reference = formatScriptureReference(entry.name, chapter, spansSpec);
    add(start, start + raw.length, `${base}/explore?q=${encodeURIComponent(reference)}`, 'scripture');
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  return spans;
}

function spanAttrs(kind: EmailRichSpanKind): string {
  if (kind === 'mention') {
    return `class="${EMAIL_CLASS.text}" style="color:${EMAIL.text};font-weight:700;text-decoration:underline;"`;
  }
  if (kind === 'hashtag' || kind === 'cashtag') {
    return `class="${EMAIL_CLASS.muted}" style="color:${EMAIL.muted};text-decoration:underline;"`;
  }
  return `class="${EMAIL_CLASS.link}" style="color:${EMAIL.brassLink};text-decoration:underline;"`;
}

/** Escape + autolink the same tokens the lodge detects on the site. */
export function linkifyEmailText(raw: string, siteUrl: string | null | undefined): string {
  const text = (raw ?? '').toString();
  if (!text) return '';
  const origin = siteOriginFromUrl(siteUrl) || (siteUrl ?? '').replace(/\/$/, '');
  if (!origin) return escapeHtml(text);

  const spans = collectSpans(text, origin);
  if (spans.length === 0) return escapeHtml(text);

  let out = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) out += escapeHtml(text.slice(cursor, span.start));
    const label = escapeHtml(text.slice(span.start, span.end));
    out += `<a href="${escapeHtml(span.href)}" ${spanAttrs(span.kind)}>${label}</a>`;
    cursor = span.end;
  }
  if (cursor < text.length) out += escapeHtml(text.slice(cursor));
  return out;
}
