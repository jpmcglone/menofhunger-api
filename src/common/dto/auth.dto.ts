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

/**
 * Present on `GET /auth/me` when the current session is a person acting as a page.
 * Describes the operator so clients can show a switcher / return-home affordance.
 */
export type AccountSwitchDto = {
  operatorUserId: string;
  operatorUsername: string | null;
  operatorName: string | null;
  operatorAvatarUrl: string | null;
};

export type SwitchableAccountDto = {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  accountKind: 'person' | 'page';
  isOrganization: boolean;
  isCurrent: boolean;
  /** Bell + groups + chat unread for this identity. Hidden on the current row. */
  unreadBadgeCount: number;
};

export type AuthMeDto = UserDto & {
  /** Published, non-deleted posts excluding only-me. Matches the profile total. */
  postCount: number | null;
  articleCount: number | null;
  /** Non-null only while a site admin is impersonating this user. */
  impersonation: ImpersonationDto | null;
  /** Non-null while a person is acting as a page. */
  accountSwitch: AccountSwitchDto | null;
  notificationUndeliveredCount: number;
  notificationUnreadCommentCount: number;
  groupsUnread: {
    total: number;
    byGroupId: Record<string, number>;
  };
  crewInviteInboxCount: number;
  groupInviteInboxCount: number;
  messageUnreadCounts: {
    primary: number;
    requests: number;
  };
};
