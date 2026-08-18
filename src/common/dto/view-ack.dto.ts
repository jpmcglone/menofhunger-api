/** Result of one accepted or no-op view report. Additive — old clients ignore the body. */
export type PostViewAckDto = {
  id: string;
  uniqueCounted: boolean;
  totalCounted: boolean;
  /** Unique people (person × post). */
  viewerCount: number;
  /** Accepted impressions, including revisits after the 30s gate. */
  totalViewCount: number;
};

export type ArticleViewAckDto = {
  id: string;
  uniqueCounted: boolean;
  totalCounted: boolean;
  /** Unique people (person × article). */
  viewCount: number;
  /** Accepted impressions, including revisits after the 30s gate. */
  totalViewCount: number;
};
