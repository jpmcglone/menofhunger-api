import {
  AD_CADENCE_MS,
  ANNOUNCEMENT_CADENCE_MS,
  canSeeAds,
  isAdCadenceOpen,
  isAnnouncementCadenceOpen,
  isAudienceEligibleForAds,
  isOnboarded,
  hasRemainingViews,
  pickNextAd,
  pickNextAnnouncement,
  viewerKeyFor,
} from './announcements.selection';

describe('announcements.selection', () => {
  const now = new Date('2026-08-15T16:00:00.000Z');

  it('requires full onboarding', () => {
    expect(
      isOnboarded({
        usernameIsSet: true,
        birthdate: new Date('1990-01-01'),
        interests: ['strength_training'],
        menOnlyConfirmed: true,
      }),
    ).toBe(true);
    expect(
      isOnboarded({
        usernameIsSet: true,
        birthdate: new Date('1990-01-01'),
        interests: [],
        menOnlyConfirmed: true,
      }),
    ).toBe(false);
  });

  it('hides ads from premium and premium plus only', () => {
    expect(canSeeAds(null)).toBe(true);
    expect(canSeeAds({ premium: false, premiumPlus: false })).toBe(true);
    expect(canSeeAds({ premium: true, premiumPlus: false })).toBe(false);
    expect(canSeeAds({ premium: false, premiumPlus: true })).toBe(false);
  });

  it('gates new viewers and ad cadence at 12 hours, announcements at 24 hours', () => {
    expect(isAudienceEligibleForAds(new Date(now.getTime() - AD_CADENCE_MS), now)).toBe(true);
    expect(isAudienceEligibleForAds(new Date(now.getTime() - AD_CADENCE_MS + 1), now)).toBe(false);
    expect(isAdCadenceOpen(null, now)).toBe(true);
    expect(isAdCadenceOpen(new Date(now.getTime() - AD_CADENCE_MS), now)).toBe(true);
    expect(isAdCadenceOpen(new Date(now.getTime() - AD_CADENCE_MS + 1000), now)).toBe(false);
    expect(isAnnouncementCadenceOpen(new Date(now.getTime() - ANNOUNCEMENT_CADENCE_MS), now)).toBe(true);
    expect(isAnnouncementCadenceOpen(new Date(now.getTime() - ANNOUNCEMENT_CADENCE_MS + 1000), now)).toBe(false);
  });

  it('picks unseen announcements first, then the furthest-back completed', () => {
    const older = new Date('2026-08-01T00:00:00.000Z');
    const newer = new Date('2026-08-10T00:00:00.000Z');
    expect(
      pickNextAnnouncement(
        [
          { id: 'seen', publishedAt: older, lastCompletedAt: new Date('2026-08-14T00:00:00.000Z') },
          { id: 'fresh', publishedAt: newer, lastCompletedAt: null },
        ],
        now,
      ),
    ).toBe('fresh');
    expect(
      pickNextAnnouncement(
        [
          { id: 'recent', publishedAt: older, lastCompletedAt: new Date('2026-08-14T12:00:00.000Z') },
          { id: 'oldest', publishedAt: newer, lastCompletedAt: new Date('2026-08-10T12:00:00.000Z') },
        ],
        now,
      ),
    ).toBe('oldest');
  });

  it('skips a recently completed announcement but still picks an unseen sibling', () => {
    const older = new Date('2026-08-01T00:00:00.000Z');
    const newer = new Date('2026-08-10T00:00:00.000Z');
    expect(
      pickNextAnnouncement(
        [
          { id: 'just-seen', publishedAt: older, lastCompletedAt: new Date(now.getTime() - 60 * 60 * 1000) },
          { id: 'fresh', publishedAt: newer, lastCompletedAt: null },
        ],
        now,
      ),
    ).toBe('fresh');
    expect(
      pickNextAnnouncement(
        [{ id: 'just-seen', publishedAt: older, lastCompletedAt: new Date(now.getTime() - 60 * 60 * 1000) }],
        now,
      ),
    ).toBeNull();
  });

  it('rotates ads: unseen first, then furthest-back completed', () => {
    const a = new Date('2026-08-01T00:00:00.000Z');
    const b = new Date('2026-08-02T00:00:00.000Z');
    expect(
      pickNextAd(
        [
          { id: 'seen', publishedAt: a, lastCompletedAt: new Date('2026-08-14T00:00:00.000Z') },
          { id: 'fresh', publishedAt: b, lastCompletedAt: null },
        ],
        now,
      ),
    ).toBe('fresh');
    expect(
      pickNextAd(
        [
          { id: 'recent', publishedAt: a, lastCompletedAt: new Date('2026-08-14T12:00:00.000Z') },
          { id: 'oldest', publishedAt: b, lastCompletedAt: new Date('2026-08-10T12:00:00.000Z') },
        ],
        now,
      ),
    ).toBe('oldest');
  });

  it('caps remaining views per person per platform', () => {
    expect(hasRemainingViews(0, 1)).toBe(true);
    expect(hasRemainingViews(1, 1)).toBe(false);
    expect(hasRemainingViews(1, 2)).toBe(true);
    expect(hasRemainingViews(2, 2)).toBe(false);
  });

  it('builds viewer keys from user first, then anonymous', () => {
    expect(viewerKeyFor('u1', 'anon-1234567890')).toBe('user:u1');
    expect(viewerKeyFor(null, 'anon-1234567890')).toBe('anon:anon-1234567890');
    expect(viewerKeyFor(null, null)).toBeNull();
  });
});
