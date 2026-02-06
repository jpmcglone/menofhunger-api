import * as fs from 'node:fs';
import * as path from 'node:path';

export type RadioStation = {
  id: string;
  name: string;
  streamUrl: string;
  attributionName: string | null;
  attributionUrl: string | null;
};

const FALLBACK_RADIO_STATIONS: RadioStation[] = [
  {
    id: 'groovesalad',
    name: 'Groove Salad',
    streamUrl: 'https://ice1.somafm.com/groovesalad-128-mp3',
    attributionName: 'SomaFM',
    attributionUrl: 'https://somafm.com/groovesalad/',
  },
  {
    id: 'dronezone',
    name: 'Drone Zone',
    streamUrl: 'https://ice1.somafm.com/dronezone-128-mp3',
    attributionName: 'SomaFM',
    attributionUrl: 'https://somafm.com/dronezone/',
  },
  {
    id: 'missioncontrol',
    name: 'Mission Control',
    streamUrl: 'https://ice1.somafm.com/missioncontrol-128-mp3',
    attributionName: 'SomaFM',
    attributionUrl: 'https://somafm.com/missioncontrol/',
  },
  {
    id: 'illstreet',
    name: 'Illinois Street Lounge',
    streamUrl: 'https://ice1.somafm.com/illstreet-128-mp3',
    attributionName: 'SomaFM',
    attributionUrl: 'https://somafm.com/illstreet/',
  },
  {
    id: 'fluid',
    name: 'Fluid',
    streamUrl: 'https://ice1.somafm.com/fluid-128-mp3',
    attributionName: 'SomaFM',
    attributionUrl: 'https://somafm.com/fluid/',
  },
  {
    id: 'lush',
    name: 'Lush',
    streamUrl: 'https://ice1.somafm.com/lush-128-mp3',
    attributionName: 'SomaFM',
    attributionUrl: 'https://somafm.com/lush/',
  },
  {
    id: 'ancientfaith',
    name: 'Ancient Faith (Music)',
    streamUrl: 'https://ancientfaith.streamguys1.com/music',
    attributionName: 'Ancient Faith Radio',
    attributionUrl: 'https://www.ancientfaith.com/',
  },
];

function safeString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function loadStationsFromJson(): RadioStation[] {
  try {
    // Support both ts-node (src/**) and compiled dist/** execution.
    const candidates = [
      path.join(__dirname, '../../../config/radio-stations.json'),
      path.join(process.cwd(), 'config', 'radio-stations.json'),
    ];
    const jsonPath = candidates.find((p) => fs.existsSync(p)) ?? null;
    if (!jsonPath) return FALLBACK_RADIO_STATIONS;
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return FALLBACK_RADIO_STATIONS;
    const stations: RadioStation[] = [];
    for (const item of parsed) {
      const obj = item as Record<string, unknown>;
      const id = safeString(obj?.id);
      const name = safeString(obj?.name);
      const streamUrl = safeString(obj?.streamUrl);
      if (!id || !name || !streamUrl) continue;
      stations.push({
        id,
        name,
        streamUrl,
        attributionName: safeString(obj?.attributionName),
        attributionUrl: safeString(obj?.attributionUrl),
      });
    }
    return stations.length > 0 ? stations : FALLBACK_RADIO_STATIONS;
  } catch {
    return FALLBACK_RADIO_STATIONS;
  }
}

export const RADIO_STATIONS: RadioStation[] = loadStationsFromJson();

export const RADIO_STATION_IDS = new Set(RADIO_STATIONS.map((s) => s.id));

