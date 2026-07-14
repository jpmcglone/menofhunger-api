import type { UserDto } from './user.dto';

export type BrowserHandoffDto = {
  handoffUrl: string;
  expiresAt: string;
};

export type AuthMeDto = UserDto & {
  postCount: number | null;
  articleCount: number | null;
  notificationUndeliveredCount: number;
  notificationUnreadCommentCount: number;
  groupsUnread: {
    total: number;
    byGroupId: Record<string, number>;
  };
  crewInviteInboxCount: number;
  messageUnreadCounts: {
    primary: number;
    requests: number;
  };
};
