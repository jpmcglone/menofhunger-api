import type { SpaceMode } from '@prisma/client';
import { RADIO_STATIONS } from '../radio/radio.constants';

/**
 * Derive the on-air title from what's playing. Does not overwrite the stored
 * space title (idle/identity + notifications still use that).
 */
export async function resolveSpacePlaybackTitle(input: {
  mode: SpaceMode;
  watchPartyUrl: string | null;
  radioStreamUrl: string | null;
  getLinkTitle: (url: string) => Promise<string | null>;
}): Promise<string | null> {
  if (input.mode === 'RADIO') {
    const url = input.radioStreamUrl?.trim();
    if (!url) return null;
    return RADIO_STATIONS.find((s) => s.streamUrl === url)?.name ?? null;
  }
  if (input.mode === 'WATCH_PARTY') {
    const url = input.watchPartyUrl?.trim();
    if (!url) return null;
    try {
      const title = await input.getLinkTitle(url);
      const trimmed = title?.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }
  return null;
}
