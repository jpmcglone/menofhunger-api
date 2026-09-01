import { describe, expect, it } from '@jest/globals';
import {
  dimensionsFromEmbedJs,
  isRumbleVideoUrl,
  needsRumbleDimensionRefresh,
  rumbleEmbedIdFromUrl,
} from './rumble-link-metadata';

describe('Rumble link metadata', () => {
  it('detects rumble hosts', () => {
    expect(isRumbleVideoUrl('https://rumble.com/v123-hello.html')).toBe(true);
    expect(isRumbleVideoUrl('https://www.rumble.com/embed/v123abc/')).toBe(true);
    expect(isRumbleVideoUrl('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
  });

  it('extracts the embed id from simple and dotted embed paths', () => {
    expect(rumbleEmbedIdFromUrl('https://rumble.com/embed/v456is6/')).toBe('v456is6');
    expect(rumbleEmbedIdFromUrl('https://www.rumble.com/embed/u4nvf6q.v70bqqu/')).toBe('v70bqqu');
    expect(rumbleEmbedIdFromUrl('https://rumble.com/embed/v456is6/?pub=7a20')).toBe('v456is6');
    expect(rumbleEmbedIdFromUrl('https://rumble.com/v123-hello.html')).toBeNull();
    expect(rumbleEmbedIdFromUrl('https://example.com/embed/v456is6/')).toBeNull();
  });

  it('reads encoded size from embedJS w/h and ignores thumbnail arrays', () => {
    expect(dimensionsFromEmbedJs({ w: 1080, h: 1920 })).toEqual({ width: 1080, height: 1920 });
    expect(dimensionsFromEmbedJs({ w: 1920.9, h: 1080.2 })).toEqual({ width: 1920, height: 1080 });
    expect(dimensionsFromEmbedJs({ w: 0, h: 1080 })).toBeNull();
    expect(dimensionsFromEmbedJs({ t: [{ w: 720, h: 1280 }] })).toBeNull();
    expect(dimensionsFromEmbedJs(null)).toBeNull();
  });

  it('re-enriches rumble rows that predate sizedBy', () => {
    expect(needsRumbleDimensionRefresh(null)).toBe(false);
    expect(
      needsRumbleDimensionRefresh({
        videoEmbed: {
          platform: 'rumble',
          embedUrl: 'https://rumble.com/embed/v456is6/',
          thumbnailUrl: null,
          width: 854,
          height: 480,
        },
      }),
    ).toBe(true);
    expect(
      needsRumbleDimensionRefresh({
        videoEmbed: {
          platform: 'rumble',
          embedUrl: 'https://rumble.com/embed/v456is6/',
          thumbnailUrl: null,
          width: 1080,
          height: 1920,
          sizedBy: 'embedjs',
        },
      }),
    ).toBe(false);
    expect(
      needsRumbleDimensionRefresh({
        videoEmbed: {
          platform: 'rumble',
          embedUrl: 'https://rumble.com/embed/v456is6/',
          thumbnailUrl: null,
          width: 854,
          height: 480,
          sizedBy: 'oembed',
        },
      }),
    ).toBe(false);
  });
});
