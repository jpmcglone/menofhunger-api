import type { UserDto } from './user.dto';

export type AuthMeDto = UserDto & {
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
