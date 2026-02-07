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

// Lightweight group keywords so group-name searches (e.g. "fitness") work even if no post text matches.
const GROUP_KEYWORDS: Record<string, string[]> = {
  Fitness: ['fitness', 'gym', 'strength', 'lifting'],
  Endurance: ['endurance', 'cardio', 'running', 'cycling'],
  Sports: ['sports'],
  'Combat sports': ['combat', 'fight', 'fighting', 'martial', 'grappling', 'striking'],
  Outdoors: ['outdoors', 'outdoor', 'nature', 'hiking', 'camping'],
  Motors: ['motors', 'cars', 'motorcycles', 'automotive', 'vehicles'],
  'Food & drink': ['food', 'drink', 'cooking', 'bbq', 'grilling'],
  'Tech & games': ['tech', 'technology', 'software', 'coding', 'programming', 'gaming'],
  Learning: ['learning', 'reading', 'books', 'study'],
  Business: ['business', 'money', 'finance', 'investing', 'career'],
  Arts: ['arts', 'music', 'movies', 'photography'],
  Family: ['family', 'fatherhood', 'parenting'],
  Religion: ['religion', 'faith', 'spiritual'],
  Politics: ['politics', 'news', 'government', 'policy', 'elections'],
  Community: ['community', 'volunteering', 'mentorship'],
  Wellness: ['wellness', 'health', 'nutrition', 'mental health', 'meditation', 'yoga'],
  Life: ['life', 'travel', 'road trips'],
};

export function inferTopicsFromText(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const hay = ` ${normalized} `;
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

