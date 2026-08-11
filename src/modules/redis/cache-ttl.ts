export const CacheTtl = {
  // Push delivery caches — kept short because correctness matters more than hit rate.
  /** Actor avatar/name for rich APNs enrichment. 5-min lag on profile changes is fine for push. */
  pushActorMiniSeconds: 5 * 60,
  /** Notification preferences per recipient. Invalidated explicitly on updatePreferences. */
  pushPrefsSeconds: 5 * 60,
  /** APNs device tokens per user. Invalidated explicitly on register/unregister to stop pushes after logout. */
  pushApnsTokensSeconds: 15 * 60,
  /** Null-result TTL for deleted/missing actor users — prevents stampede on the DB. */
  pushActorMiniNullSeconds: 30,
  // Anonymous read caches (fast invalidation via version bumps).
  anonFeedSeconds: 30,
  authFeedSeconds: 15,
  authCursorFeedSeconds: 8,
  forYouRankedPage1Seconds: 15,
  anonTopicsListSeconds: 60,
  anonTopicPostsSeconds: 30,
  anonSearchPostsSeconds: 30,
  /** Post-context discover-more candidate id lists. */
  discoverMoreIdsSeconds: 10 * 60,

  // External/shared caches.
  giphySeconds: 30,
  linkMetaFrontSeconds: 6 * 60 * 60,
  linkMetaNullSeconds: 60,
  // Scripture verse text is immutable public-domain content; 30-day TTL.
  scriptureChapterSeconds: 30 * 24 * 60 * 60,
  // US geocode normalizations are fairly stable.
  geoUsSeconds: 30 * 24 * 60 * 60,
} as const;

