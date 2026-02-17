export const CacheTtl = {
  // Anonymous read caches (fast invalidation via version bumps).
  anonFeedSeconds: 30,
  anonTopicsListSeconds: 60,
  anonTopicPostsSeconds: 30,
  anonSearchPostsSeconds: 30,

  // External/shared caches.
  giphySeconds: 30,
  linkMetaFrontSeconds: 6 * 60 * 60,
  linkMetaNullSeconds: 60,
  // US geocode normalizations are fairly stable.
  geoUsSeconds: 30 * 24 * 60 * 60,
} as const;

