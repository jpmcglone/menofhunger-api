import { RADIO_STATIONS } from '../radio/radio.constants';
import { resolveSpacePlaybackTitle } from './spaces-playback-title';

describe('resolveSpacePlaybackTitle', () => {
  it('maps a radio stream URL to the station name', async () => {
    const station = RADIO_STATIONS[0];
    expect(station).toBeDefined();
    const getLinkTitle = jest.fn(async () => 'should not be called');
    await expect(
      resolveSpacePlaybackTitle({
        mode: 'RADIO',
        watchPartyUrl: null,
        radioStreamUrl: station!.streamUrl,
        getLinkTitle,
      }),
    ).resolves.toBe(station!.name);
    expect(getLinkTitle).not.toHaveBeenCalled();
  });

  it('returns null for an unknown radio stream URL', async () => {
    await expect(
      resolveSpacePlaybackTitle({
        mode: 'RADIO',
        watchPartyUrl: null,
        radioStreamUrl: 'https://example.com/unknown.mp3',
        getLinkTitle: async () => 'nope',
      }),
    ).resolves.toBeNull();
  });

  it('uses LinkMetadata title for a watch-party URL', async () => {
    const getLinkTitle = jest.fn(async () => 'Never Gonna Give You Up');
    await expect(
      resolveSpacePlaybackTitle({
        mode: 'WATCH_PARTY',
        watchPartyUrl: 'https://youtu.be/dQw4w9WgXcQ',
        radioStreamUrl: null,
        getLinkTitle,
      }),
    ).resolves.toBe('Never Gonna Give You Up');
    expect(getLinkTitle).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ');
  });

  it('returns null when OG fetch fails', async () => {
    await expect(
      resolveSpacePlaybackTitle({
        mode: 'WATCH_PARTY',
        watchPartyUrl: 'https://youtu.be/dQw4w9WgXcQ',
        radioStreamUrl: null,
        getLinkTitle: async () => {
          throw new Error('timeout');
        },
      }),
    ).resolves.toBeNull();
  });

  it('returns null for NONE or missing URLs', async () => {
    const getLinkTitle = jest.fn(async () => 'nope');
    await expect(
      resolveSpacePlaybackTitle({
        mode: 'NONE',
        watchPartyUrl: 'https://youtu.be/dQw4w9WgXcQ',
        radioStreamUrl: 'https://ice1.somafm.com/groovesalad-128-mp3',
        getLinkTitle,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveSpacePlaybackTitle({
        mode: 'WATCH_PARTY',
        watchPartyUrl: null,
        radioStreamUrl: null,
        getLinkTitle,
      }),
    ).resolves.toBeNull();
    expect(getLinkTitle).not.toHaveBeenCalled();
  });
});
