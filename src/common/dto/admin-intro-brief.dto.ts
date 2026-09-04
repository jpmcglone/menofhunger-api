export type AdminIntroPersonDto = {
  id: string;
  username: string;
  name: string | null;
};

export type AdminIntroPairDto = {
  left: AdminIntroPersonDto;
  right: AdminIntroPersonDto;
  topics: string[];
  reason: string;
};

/** Latest weekly admin intro briefing. */
export type AdminIntroBriefDto = {
  weekKey: string;
  brief: string;
  pairs: AdminIntroPairDto[];
  modelUsed: string;
  createdAt: string;
};