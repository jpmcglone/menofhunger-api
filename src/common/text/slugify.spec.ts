import {
  slugifyArticleTitle,
  slugifyBoardTag,
  slugifyChannelName,
  slugifyCollectionName,
  slugifyCrewHandle,
  slugifyHandle,
  slugifyTopic,
} from './slugify';

// Verbatim copies of the per-module implementations these variants replaced. Stored slugs
// depend on them, so every variant must stay byte-identical.
const legacy = {
  groups: (name: string) =>
    (name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72),
  crew: (input: string) => {
    const v = (input ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72);
    return v || 'crew';
  },
  bookmarks: (name: string) =>
    (name ?? '').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-'),
  taxonomy: (raw: string) =>
    (raw ?? '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80),
  articles: (text: string) =>
    text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 80),
  board: (raw: string | null | undefined) => {
    const slug = (raw ?? '')
      .trim()
      .replace(/^#+/, '')
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24);
    return slug.length >= 2 ? slug : null;
  },
  channels: (value: string) =>
    value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80),
};

const corpus = [
  '',
  ' ',
  'a',
  'Hello World',
  '  Leading and trailing  ',
  'Café & Prayer!',
  'Morning Workout 💪',
  '#Show HN',
  '##ask__me',
  'snake_case_name',
  'multiple---hyphens',
  '-edge-hyphens-',
  'Ünïcödé Ñame',
  'Tabs\tand\nnewlines',
  'MiXeD 123 Numbers 456',
  '!!!',
  'ab',
  'x'.repeat(100),
  'word '.repeat(30),
  'Men of Hunger: The Lodge (2026)',
];

describe('slugify variants match the implementations they replaced', () => {
  it.each(corpus)('%j', (input) => {
    expect(slugifyHandle(input)).toBe(legacy.groups(input));
    expect(slugifyCrewHandle(input)).toBe(legacy.crew(input));
    expect(slugifyCollectionName(input)).toBe(legacy.bookmarks(input));
    expect(slugifyTopic(input)).toBe(legacy.taxonomy(input));
    expect(slugifyArticleTitle(input)).toBe(legacy.articles(input));
    expect(slugifyBoardTag(input, 24)).toBe(legacy.board(input));
    expect(slugifyChannelName(input)).toBe(legacy.channels(input));
  });

  it('pins representative outputs per variant', () => {
    expect(slugifyHandle('Café & Prayer!')).toBe('caf-prayer');
    expect(slugifyCrewHandle('!!!')).toBe('crew');
    expect(slugifyCollectionName('My  Saved -- Posts')).toBe('my-saved-posts');
    expect(slugifyTopic('Hello_World Topic')).toBe('helloworld-topic');
    expect(slugifyArticleTitle('Hello_World Topic')).toBe('hello-world-topic');
    expect(slugifyBoardTag('#Show HN', 24)).toBe('show-hn');
    expect(slugifyBoardTag('a', 24)).toBeNull();
    expect(slugifyChannelName('Café & Prayer!')).toBe('cafe-prayer');
    expect(slugifyHandle('x'.repeat(100))).toHaveLength(72);
    expect(slugifyTopic('x'.repeat(100))).toHaveLength(80);
  });

  it('keeps null-safe inputs null-safe', () => {
    expect(slugifyHandle(undefined as unknown as string)).toBe('');
    expect(slugifyCrewHandle(null as unknown as string)).toBe('crew');
    expect(slugifyBoardTag(null, 24)).toBeNull();
  });
});
