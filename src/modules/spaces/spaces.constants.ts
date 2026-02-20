import * as fs from 'node:fs';
import * as path from 'node:path';

export type SpaceConfig = {
  id: string;
  name: string;
  stationId: string | null;
};

/** Retreat/lodge place names (Men of Hunger is the lodge; these are places within it). IDs are URL slugs matching the space names. */
const FALLBACK_SPACES: SpaceConfig[] = [
  { id: 'the-study', name: 'The Study', stationId: 'dronezone' },
  { id: 'the-hearth', name: 'The Hearth', stationId: 'groovesalad' },
  { id: 'the-map-room', name: 'The Map Room', stationId: 'missioncontrol' },
  { id: 'the-lounge', name: 'The Lounge', stationId: 'illstreet' },
  { id: 'the-spring', name: 'The Spring', stationId: 'fluid' },
  { id: 'the-garden', name: 'The Garden', stationId: 'lush' },
  { id: 'the-chapel', name: 'The Chapel', stationId: 'ancientfaith' },
];

function safeString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function loadSpacesFromJson(): SpaceConfig[] {
  try {
    // Support both ts-node (src/**) and compiled dist/** execution.
    const candidates = [
      path.join(__dirname, '../../../config/spaces.json'),
      path.join(process.cwd(), 'config', 'spaces.json'),
    ];
    const jsonPath = candidates.find((p) => fs.existsSync(p)) ?? null;
    if (!jsonPath) return FALLBACK_SPACES;
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return FALLBACK_SPACES;

    const spaces: SpaceConfig[] = [];
    for (const item of parsed) {
      const obj = item as Record<string, unknown>;
      const id = safeString(obj?.id);
      const name = safeString(obj?.name);
      if (!id || !name) continue;
      const stationId = safeString(obj?.stationId);
      spaces.push({ id, name, stationId });
    }

    return spaces.length > 0 ? spaces : FALLBACK_SPACES;
  } catch {
    return FALLBACK_SPACES;
  }
}

export const SPACES: SpaceConfig[] = loadSpacesFromJson();

export const SPACE_IDS = new Set(SPACES.map((s) => s.id));

