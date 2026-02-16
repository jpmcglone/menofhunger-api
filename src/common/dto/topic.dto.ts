export type TopicDto = {
  /** Normalized topic string (lowercase, spaces). Safe to URL-encode and use as route param. */
  topic: string;
  /** Canonical category key (lowercase). */
  category: string;
  /** Human-friendly category label (e.g. "Technology"). */
  categoryLabel: string;
  /** Composite score used for ranking only. */
  score: number;
  /** How many times this topic appeared in users' interests. */
  interestCount: number;
  /** How many times this topic appeared in recent post text. */
  postCount: number;
  /** When viewer is authenticated, whether they follow this topic. */
  viewerFollows?: boolean;
};

export type TopicCategoryDto = {
  /** Canonical category key (lowercase). */
  category: string;
  /** Human-friendly label (e.g. "Technology"). */
  label: string;
  /** Composite score used for ranking only. */
  score: number;
  /** Sum of interestCount across topics in this category. */
  interestCount: number;
  /** Sum of postCount across topics in this category. */
  postCount: number;
};

