import { isDefaultSpaceTitle, resolveSpaceEventTitle } from './spaces-event-title';

describe('resolveSpaceEventTitle', () => {
  it('treats the create default as not an override', () => {
    expect(isDefaultSpaceTitle("ocaptain's Space")).toBe(true);
    expect(isDefaultSpaceTitle("ocaptain's space")).toBe(true);
    expect(isDefaultSpaceTitle('The Great Debate')).toBe(false);
  });

  it('prefers a custom title over playback', () => {
    expect(
      resolveSpaceEventTitle({ title: 'The Great Debate', playbackTitle: 'YouTube video' }),
    ).toBe('The Great Debate');
  });

  it('uses playback when the stored title is the default', () => {
    expect(
      resolveSpaceEventTitle({ title: "ocaptain's Space", playbackTitle: 'Conference talk' }),
    ).toBe('Conference talk');
  });

  it('falls back to the stored title', () => {
    expect(resolveSpaceEventTitle({ title: "ocaptain's Space", playbackTitle: null })).toBe(
      "ocaptain's Space",
    );
  });

  it('treats a cleared title as no override', () => {
    expect(isDefaultSpaceTitle(null)).toBe(false);
    expect(resolveSpaceEventTitle({ title: null, playbackTitle: 'Conference talk' })).toBe(
      'Conference talk',
    );
    expect(resolveSpaceEventTitle({ title: null, playbackTitle: null })).toBe('Space');
  });
});
