import type { UserListDto, UserNotificationPreference } from '../../common/dto/user.dto';
import type { AvatarVideoDto } from '../../common/dto/avatar-video.dto';
import { type NudgeStateDto } from '../../common/dto';

export type FollowRelationship = {
  viewerFollowsUser: boolean;
  userFollowsViewer: boolean;
  /** True when viewer enabled reply notifications for this follow (bell icon). */
  viewerPostNotificationsEnabled: boolean;
  viewerNotificationPreference?: UserNotificationPreference;
};

export type FollowSummary = FollowRelationship & {
  canView: boolean;
  followerCount: number | null;
  followingCount: number | null;
  nudge: NudgeStateDto | null;
  /** Social proof: accounts the viewer follows who also follow this user. Null when signed out or self. */
  followedBy: FollowedByPreview | null;
};

/** Up to `FOLLOWED_BY_PREVIEW_LIMIT` names/avatars plus the full count behind them. */
export type FollowedByPreview = {
  users: Array<{
    id: string;
    username: string | null;
    name: string | null;
    avatarUrl: string | null;
    avatarVideo?: AvatarVideoDto | null;
    isOrganization: boolean;
  }>;
  total: number;
};

export const FOLLOWED_BY_PREVIEW_LIMIT = 3;

/** Follow-list row: a user list item that always carries the viewer's relationship. */
export type FollowListUser = UserListDto & {
  relationship: FollowRelationship;
};
