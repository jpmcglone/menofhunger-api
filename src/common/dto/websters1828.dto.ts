export type Websters1828WordOfDayDto = {
  word: string;
  dictionaryUrl: string;
  definition: string | null;
  definitionHtml: string | null;
  sourceUrl: string;
  fetchedAt: string;
  likeCount: number;
  viewerHasLiked: boolean;
};

export type WotdLikeBreakdownDto = {
  premium: number;
  verified: number;
  unverified: number;
  total: number;
};

export type WotdLikeToggleDto = {
  liked: boolean;
  likeCount: number;
};
