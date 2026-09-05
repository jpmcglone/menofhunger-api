export type AdminIntroPersonDto = {
  id: string;
  username: string;
  name: string | null;
};

export type AdminIntroPairDto = {
  left: AdminIntroPersonDto;
  right: AdminIntroPersonDto;
  topics: string[];
  groups: string[];
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

/** POST /admin/intros/brief queues Astra; poll GET for the written row. */
export type AdminIntroBriefQueuedDto = {
  queued: true;
  weekKey: string;
};