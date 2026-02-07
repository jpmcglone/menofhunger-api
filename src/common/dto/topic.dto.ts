export type TopicDto = {
  /** Normalized topic string (lowercase, spaces). Safe to URL-encode and use as route param. */
  topic: string;
  /** Composite score used for ranking only. */
  score: number;
  /** How many times this topic appeared in users' interests. */
  interestCount: number;
  /** How many times this topic appeared in recent post text. */
  postCount: number;
};

