import { TOPIC_OPTIONS } from './topic-options';

function normalizeText(s: string): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordMatch(haystackPadded: string, needle: string): boolean {
  // haystackPadded is expected to have a leading+trailing space.
  return haystackPadded.includes(` ${needle} `);
}

function buildOptionPhrases(): Array<{ value: string; phrases: string[]; group: string }> {
  return TOPIC_OPTIONS.map((o) => {
    const raw = [o.value, o.label, ...(o.aliases ?? [])];
    const phrases = Array.from(new Set(raw.map(normalizeText).filter(Boolean)));
    return { value: o.value, phrases, group: o.group };
  });
}

const OPTION_PHRASES = buildOptionPhrases();

const ALLOWED_TOPIC_VALUES = new Set(TOPIC_OPTIONS.map((o) => o.value));

export function canonicalizeTopicValue(raw: string): string | null {
  const key = normalizeText(raw);
  if (!key) return null;
  const padded = ` ${key} `;
  // Use the same phrase matching rules as inference; return the first (stable-order) match.
  for (const o of OPTION_PHRASES) {
    for (const p of o.phrases) {
      if (!p) continue;
      if (p.includes(' ')) {
        if (padded.includes(` ${p} `)) return o.value;
      } else {
        if (wordMatch(padded, p)) return o.value;
      }
    }
  }
  return null;
}

export function topicCategory(value: string): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  const opt = TOPIC_OPTIONS.find((o) => o.value === v);
  return opt?.group ?? null;
}

// Very strong signal: link domain → topic(s)
// Keep this small + high precision; it's easy to extend safely.
const DOMAIN_TOPIC_MAP: Record<string, string[]> = {
  // AI / research
  'openai.com': ['ai'],
  'platform.openai.com': ['ai'],
  'x.ai': ['ai'],
  'anthropic.com': ['ai'],
  'deepmind.com': ['ai'],
  'arxiv.org': ['ai', 'programming'],
  'huggingface.co': ['ai'],
  'kaggle.com': ['ai'],
  'pytorch.org': ['ai'],
  'tensorflow.org': ['ai'],
  // Coding
  'github.com': ['programming'],
  'gitlab.com': ['programming'],
  'stackoverflow.com': ['programming'],
  // Endurance / training
  'strava.com': ['endurance_training'],
  'garmin.com': ['endurance_training'],
  'trainingpeaks.com': ['endurance_training'],
  // Games (broad)
  'chess.com': ['gaming'],
  'lichess.org': ['gaming'],
};

function baseDomainFromHost(host: string): string {
  const h = (host ?? '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  if (!h) return '';
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  // NOTE: This is a pragmatic heuristic (not a full public suffix list).
  return parts.slice(-2).join('.');
}

function extractLinkDomainsFromText(text: string): string[] {
  const raw = (text ?? '').trim();
  if (!raw) return [];
  const urlRe = /\bhttps?:\/\/[^\s<>()]+/gi;
  const out = new Set<string>();
  const matches = raw.match(urlRe) ?? [];
  for (let u of matches) {
    u = u.trim().replace(/[),.;!?]+$/g, '');
    try {
      const parsed = new URL(u);
      let host = (parsed.hostname ?? '').toLowerCase();
      if (host.startsWith('www.')) host = host.slice(4);
      if (!host) continue;
      out.add(host);
      const base = baseDomainFromHost(host);
      if (base) out.add(base);
    } catch {
      // ignore invalid URLs
    }
  }
  return Array.from(out);
}

function topicsFromDomains(domains: string[]): string[] {
  const out: string[] = [];
  for (const dRaw of domains ?? []) {
    const d = (dRaw ?? '').trim().toLowerCase();
    if (!d) continue;
    const direct = DOMAIN_TOPIC_MAP[d];
    if (Array.isArray(direct)) out.push(...direct);
    const base = baseDomainFromHost(d);
    const baseMapped = base ? DOMAIN_TOPIC_MAP[base] : undefined;
    if (Array.isArray(baseMapped)) out.push(...baseMapped);
  }
  // Validate against allowlist, dedupe
  return Array.from(new Set(out)).filter((t) => ALLOWED_TOPIC_VALUES.has(t));
}

function matchTopicsInHay(hayPadded: string): string[] {
  const hay = hayPadded;
  const out: string[] = [];
  for (const o of OPTION_PHRASES) {
    let matched = false;
    for (const p of o.phrases) {
      if (!p) continue;
      if (p.includes(' ')) {
        if (hay.includes(` ${p} `)) {
          matched = true;
          break;
        }
      } else {
        if (wordMatch(hay, p)) {
          matched = true;
          break;
        }
      }
    }
    if (matched) out.push(o.value);
  }
  return out;
}

// Lightweight group keywords so group-name searches (e.g. "fitness") work even if no post text matches.
const GROUP_KEYWORDS: Record<string, string[]> = {
  Religion: ['religion', 'faith', 'spiritual', 'spirituality', 'god', 'church', 'bible', 'prayer', 'theology'],
  Politics: ['politics', 'news', 'current events', 'government', 'policy', 'elections', 'law', 'taxes', 'geopolitics'],
  Business: ['business', 'money', 'finance', 'investing', 'career', 'leadership', 'management', 'marketing', 'sales', 'crypto', 'productivity'],
  Technology: ['tech', 'technology', 'software', 'coding', 'programming', 'ai', 'security', 'cloud', 'devops', 'data'],
  Health: ['health', 'fitness', 'gym', 'strength', 'cardio', 'nutrition', 'sleep', 'recovery', 'mental health', 'mobility', 'longevity'],
  Relationships: ['relationships', 'dating', 'marriage', 'family', 'fatherhood', 'friendship', 'community', 'mentorship', 'communication', 'boundaries'],
  Philosophy: ['philosophy', 'meaning', 'purpose', 'ethics', 'stoicism', 'discipline', 'habits', 'psychology', 'learning'],
};

export function inferTopicsFromText(
  text: string,
  hashtagsOrOpts?:
    | string[]
    | {
        hashtags?: string[];
        /**
         * Tie-breaker topics from related context (e.g. parent/root post topics).
         * Only used when direct inference yields few/no topics.
         */
        relatedTopics?: string[];
      },
): string[] {
  const opts = Array.isArray(hashtagsOrOpts) ? { hashtags: hashtagsOrOpts } : (hashtagsOrOpts ?? {});
  const hashtags = Array.isArray(opts.hashtags) ? opts.hashtags : [];
  const relatedTopicsRaw = Array.isArray(opts.relatedTopics) ? opts.relatedTopics : [];

  const normalizedBody = normalizeText(text);
  const tagTokens = hashtags.map(normalizeText).filter(Boolean);
  const tagsText = tagTokens.join(' ');

  // Link domains: strong signal + also useful as text tokens ("x.ai" → "x ai")
  const linkDomains = extractLinkDomainsFromText(text);
  const linkDomainTopics = topicsFromDomains(linkDomains);
  const linkDomainText = linkDomains.map(normalizeText).filter(Boolean).join(' ');

  // 1) Hashtag-first inference (exact-ish tokens)
  const fromTags = tagsText ? matchTopicsInHay(` ${tagsText} `) : [];

  // 2) Body + domains + tags combined (still whole-word/phrase safe)
  const combined = [normalizedBody, linkDomainText, tagsText].filter(Boolean).join(' ');
  const fromCombined = combined ? matchTopicsInHay(` ${combined} `) : [];

  const outSet = new Set<string>();
  for (const t of linkDomainTopics) outSet.add(t);
  for (const t of fromTags) outSet.add(t);
  for (const t of fromCombined) outSet.add(t);

  // 3) Reply tie-breaker: only if we have weak/no evidence.
  const related = relatedTopicsRaw
    .map((t) => (t ?? '').trim().toLowerCase())
    .filter((t) => Boolean(t && ALLOWED_TOPIC_VALUES.has(t)));
  if (related.length > 0 && outSet.size < 2) {
    const maxTopics = outSet.size === 0 ? 2 : 3;
    for (const t of related) {
      if (outSet.size >= maxTopics) break;
      outSet.add(t);
    }
  }

  // Preserve stable ordering (TOPIC_OPTIONS order).
  return TOPIC_OPTIONS.map((o) => o.value).filter((v) => outSet.has(v));
}

export function queryToTopicValues(query: string): string[] {
  const q = normalizeText(query);
  if (!q) return [];
  const tokens = q.split(' ').filter(Boolean);
  if (tokens.length === 0) return [];

  // Direct match to option phrases.
  const direct = new Set<string>();
  const hay = ` ${q} `;
  for (const o of OPTION_PHRASES) {
    for (const p of o.phrases) {
      if (!p) continue;
      if (p.includes(' ')) {
        if (hay.includes(` ${p} `)) {
          direct.add(o.value);
          break;
        }
      } else {
        if (wordMatch(hay, p)) {
          direct.add(o.value);
          break;
        }
      }
    }
  }

  // Group match (e.g. "fitness") or group keyword match ("gym").
  const groups = new Set<string>();
  for (const o of OPTION_PHRASES) groups.add(o.group);
  for (const g of groups) {
    const gNorm = normalizeText(g);
    const gKeys = (GROUP_KEYWORDS[g] ?? []).map(normalizeText).filter(Boolean);
    if (gNorm && wordMatch(` ${q} `, gNorm)) {
      // Whole-group query: include the entire group.
      for (const o of OPTION_PHRASES) if (o.group === g) direct.add(o.value);
      continue;
    }
    // Any keyword token hits: include the group.
    if (gKeys.some((k) => tokens.includes(k))) {
      for (const o of OPTION_PHRASES) if (o.group === g) direct.add(o.value);
    }
  }

  return Array.from(direct);
}

