/**
 * Viewer's own Marv context card — what Marv currently knows from public profile/posts.
 * Returned by `GET /marvin/me/context-card`. Null when no card has been generated yet.
 */
export type MarvinContextCardDto = {
  cardText: string;
  /** "generated" | "manual" | "hybrid" */
  source: string;
  updatedAt: string;
};
