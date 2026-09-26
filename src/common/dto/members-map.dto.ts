import type { UserListDto } from './user.dto';

export type MembersMapStateDto = {
  /** Two-letter US state or territory code, e.g. "VA". */
  state: string;
  stateDisplay: string;
  memberCount: number;
  onlineCount: number;
  /** Up to six members, online members first. */
  preview: UserListDto[];
};

export type MembersMapOnlineEntryDto = {
  userId: string;
  /** Null when the member has no location set. */
  state: string | null;
};

export type MembersMapTotalsDto = {
  members: number;
  states: number;
  online: number;
  unlocated: number;
  unlocatedOnline: number;
};

export type MembersMapSummaryDto = {
  /**
   * False for signed-out and unverified viewers: counts only. `preview`, `unlocatedPreview`,
   * and `online` are empty, and the members endpoint is unavailable.
   */
  membersVisible: boolean;
  states: MembersMapStateDto[];
  online: MembersMapOnlineEntryDto[];
  totals: MembersMapTotalsDto;
  unlocatedPreview: UserListDto[];
  asOf: string;
};
