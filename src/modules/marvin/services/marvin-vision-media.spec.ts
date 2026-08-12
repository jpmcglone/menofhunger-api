import { fillVisionSlots, marvMediaMarker, resolveMarvVisionUrl } from './marvin-vision-media';

describe('resolveMarvVisionUrl', () => {
  const base = 'https://cdn.test';

  it('uses the video poster thumbnail, not the video file', () => {
    expect(
      resolveMarvVisionUrl(
        { kind: 'video', source: 'upload', r2Key: 'posts/clip.mp4', url: null, thumbnailR2Key: 'posts/clip.jpg' },
        base,
      ),
    ).toBe('https://cdn.test/posts/clip.jpg');
  });

  it('returns null for a video with no poster', () => {
    expect(
      resolveMarvVisionUrl(
        { kind: 'video', source: 'upload', r2Key: 'posts/clip.mp4', url: null, thumbnailR2Key: null },
        base,
      ),
    ).toBeNull();
  });

  it('resolves uploaded images against the CDN base', () => {
    expect(
      resolveMarvVisionUrl(
        { kind: 'image', source: 'upload', r2Key: 'posts/bench.jpg', url: null, thumbnailR2Key: null },
        base,
      ),
    ).toBe('https://cdn.test/posts/bench.jpg');
  });

  it('keeps external GIF URLs as-is', () => {
    expect(
      resolveMarvVisionUrl(
        { kind: 'gif', source: 'giphy', r2Key: null, url: 'https://giphy.test/x.gif', thumbnailR2Key: null },
        base,
      ),
    ).toBe('https://giphy.test/x.gif');
  });
});

describe('fillVisionSlots', () => {
  it('keeps existing URLs when there are no extras', () => {
    expect(fillVisionSlots(['https://a', 'https://b'], [], 4)).toEqual(['https://a', 'https://b']);
  });

  it('appends preview images into leftover slots', () => {
    expect(fillVisionSlots(['https://a'], ['https://og'], 4)).toEqual(['https://a', 'https://og']);
  });

  it('reserves up to two slots for extras so a full thread still includes previews', () => {
    expect(
      fillVisionSlots(['https://1', 'https://2', 'https://3', 'https://4'], ['https://og-a', 'https://og-b'], 4),
    ).toEqual(['https://1', 'https://2', 'https://og-a', 'https://og-b']);
  });

  it('never drops the last post image when extras exist and cap is 1', () => {
    expect(fillVisionSlots(['https://a'], ['https://og'], 1)).toEqual(['https://a']);
  });

  it('de-dupes and ignores blanks', () => {
    expect(fillVisionSlots(['https://a', 'https://a'], ['https://a', '  ', null], 4)).toEqual(['https://a']);
  });
});

describe('marvMediaMarker', () => {
  it('names images, GIFs, and videos together', () => {
    expect(
      marvMediaMarker([
        { kind: 'image' },
        { kind: 'gif' },
        { kind: 'video' },
      ]),
    ).toBe(' [attached: image + animated GIF + video]');
  });

  it('returns empty when there is no media', () => {
    expect(marvMediaMarker([])).toBe('');
    expect(marvMediaMarker(null)).toBe('');
  });
});
