import type { UserDto } from './user.dto';

export type BrowserHandoffDto = {
  handoffUrl: string;
  expiresAt: string;
};

/**
 * Present on `GET /auth/me` when the current session was created by a site admin
 * impersonating the signed-in user. Describes the admin really driving the session,
 * so clients can show an exit affordance.
 */
export type ImpersonationDto = {
  adminUserId: string;
  adminUsername: string | null;
  adminName: string | null;
  adminAvatarUrl: string | null;
};

export type AuthMeDto = UserDto & {
  postCount: number | null;
  articleCount: number | null;
  /** Non-null only while a site admin is impersonating this user. */
  impersonation: ImpersonationDto | null;
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
