import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import { CacheService } from '../redis/cache.service';
import { RedisKeys } from '../redis/redis-keys';
import { CacheTtl } from '../redis/cache-ttl';
import { lookupBook, parseScriptureRefs, type ScriptureRef } from '../../common/scripture/scripture-reference';

export type ScriptureVerse = {
  number: number;
  text: string;
};

export type ScriptureRefDto = {
  reference: string;
  translation: string;
  translationName: string;
  verses: ScriptureVerse[];
  /** Convenience field — all verse texts joined with a space. */
  text: string;
};

/** Raw chapter shape from bible.helloao.org */
type ApiChapter = {
  chapter: {
    number: number;
    content: ApiChapterItem[];
  };
};

type ApiChapterItem = {
  type: string;
  number?: number;
  content?: ApiVerseContent[];
};

type ApiVerseContent = string | { text?: string; poem?: number; wordsOfJesus?: boolean };

const TRANSLATION_NAMES: Record<string, string> = {
  BSB: 'Berean Standard Bible',
  NKJV: 'New King James Version',
  NIV: 'New International Version',
  ESV: 'English Standard Version',
  KJV: 'King James Version',
  NLT: 'New Living Translation',
  NASB: 'New American Standard Bible',
};

function addVerseSpan(wanted: Set<number>, start: number, end: number | null): void {
  const to = end ?? start;
  for (let n = start; n <= to; n++) wanted.add(n);
}

function sliceVerses(verses: ScriptureVerse[], ref: ScriptureRef): ScriptureVerse[] {
  if (ref.verseStart == null) return verses;
  const wanted = new Set<number>();
  addVerseSpan(wanted, ref.verseStart, ref.verseEnd);
  for (const extra of ref.extraVerses) addVerseSpan(wanted, extra.start, extra.end);
  return verses.filter((v) => wanted.has(v.number));
}

@Injectable()
export class ScriptureService {
  private readonly logger = new Logger(ScriptureService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly cache: CacheService,
  ) {}

  async getRef(refString: string): Promise<ScriptureRefDto | null> {
    const refs = parseScriptureRefs(refString);
    if (!refs.length) return null;
    const ref = refs[0];
    const entry = lookupBook(ref.book);
    if (!entry) return null;

    const translation = this.config.scriptureTranslation();
    const verses = await this.fetchVerses(translation, entry.apiId, ref.chapter);
    if (!verses) return null;

    const sliced = sliceVerses(verses, ref);
    if (!sliced.length) return null;

    return {
      reference: ref.reference,
      translation,
      translationName: TRANSLATION_NAMES[translation] ?? translation,
      verses: sliced,
      text: sliced.map((v) => v.text).join(' '),
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async fetchVerses(
    translation: string,
    bookId: string,
    chapter: number,
  ): Promise<ScriptureVerse[] | null> {
    const cacheKey = RedisKeys.scriptureChapter(translation, bookId, chapter);
    return this.cache.getOrSetJson<ScriptureVerse[]>({
      enabled: true,
      key: cacheKey,
      ttlSeconds: CacheTtl.scriptureChapterSeconds,
      compute: () => this.fetchChapterFromApi(translation, bookId, chapter),
    });
  }

  private async fetchChapterFromApi(
    translation: string,
    bookId: string,
    chapter: number,
  ): Promise<ScriptureVerse[]> {
    const url = `https://bible.helloao.org/api/${translation}/${bookId}/${chapter}.json`;
    let data: ApiChapter;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        this.logger.warn(`bible.helloao.org returned ${res.status} for ${url}`);
        return [];
      }
      data = (await res.json()) as ApiChapter;
    } catch (err) {
      this.logger.warn(`Failed to fetch scripture chapter ${url}: ${String(err)}`);
      return [];
    }

    return this.flattenChapter(data);
  }

  private flattenChapter(data: ApiChapter): ScriptureVerse[] {
    const verses: ScriptureVerse[] = [];
    for (const item of data?.chapter?.content ?? []) {
      if (item.type !== 'verse' || typeof item.number !== 'number') continue;
      const text = this.flattenVerseContent(item.content ?? []);
      if (text) verses.push({ number: item.number, text });
    }
    return verses;
  }

  private flattenVerseContent(content: ApiVerseContent[]): string {
    const parts: string[] = [];
    for (const c of content) {
      if (typeof c === 'string') {
        parts.push(c);
      } else if (c && typeof c === 'object' && typeof c.text === 'string') {
        parts.push(c.text);
      }
      // Skip footnote refs (type references, line-breaks, headings handled by parent)
    }
    return parts.join('').trim();
  }
}
