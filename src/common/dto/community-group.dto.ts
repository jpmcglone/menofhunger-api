import type {
  CommunityGroup,
  CommunityGroupInvite,
  CommunityGroupInviteStatus,
  CommunityGroupJoinPolicy,
  CommunityGroupMemberRole,
  CommunityGroupMemberStatus,
} from '@prisma/client';
import { toUserListDto, type UserListDto, type UserListRow } from './user.dto';

const PREVIEW_DESC_LEN = 220;

export type CommunityGroupPreviewDto = {
  id: string;
  slug: string;
  name: string;
  descriptionPreview: string;
  coverImageUrl: string | null;
  avatarImageUrl: string | null;
  joinPolicy: CommunityGroupJoinPolicy;
  memberCount: number;
  viewerMembership: {
    status: CommunityGroupMemberStatus;
    role: CommunityGroupMemberRole;
  } | null;
  viewerPendingApproval: boolean;
};

export type CommunityGroupShellDto = {
  id: string;
  slug: string;
  name: string;
  description: string;
  rules: string | null;
  coverImageUrl: string | null;
  avatarImageUrl: string | null;
  joinPolicy: CommunityGroupJoinPolicy;
  memberCount: number;
  isFeatured: boolean;
  featuredOrder: number;
  createdAt: string;
  /** Present when viewer is authenticated; null if not a member or pending. */
  viewerMembership: {
    status: CommunityGroupMemberStatus;
    role: CommunityGroupMemberRole;
  } | null;
  viewerPendingApproval: boolean;
  /** Number of pending join requests. Only populated for owners and moderators. */
  pendingMemberCount?: number;
  /** Number of pending outbound invites issued for this group. Only populated for owners and moderators. */
  pendingInviteCount?: number;
};

export type CommunityGroupMemberUserDto = {
  userId: string;
  username: string | null;
  name: string | null;
  role: CommunityGroupMemberRole;
  status: CommunityGroupMemberStatus;
  joinedAt: string;
};

/** Active member row for group directory (avatar from R2 in API layer). */
export type CommunityGroupMemberListItemDto = {
  userId: string;
  username: string | null;
  name: string | null;
  role: CommunityGroupMemberRole;
  avatarUrl: string | null;
  joinedAt: string;
};

export function toCommunityGroupPreviewDto(
  g: CommunityGroup,
  viewerMembership: { status: CommunityGroupMemberStatus; role: CommunityGroupMemberRole } | null,
): CommunityGroupPreviewDto {
  const shell = toCommunityGroupShellDto(g, viewerMembership);
  const raw = (g.description ?? '').replace(/\s+/g, ' ').trim();
  const descriptionPreview =
    raw.length <= PREVIEW_DESC_LEN ? raw : `${raw.slice(0, PREVIEW_DESC_LEN - 1)}…`;
  return {
    id: shell.id,
    slug: shell.slug,
    name: shell.name,
    descriptionPreview,
    coverImageUrl: shell.coverImageUrl,
    avatarImageUrl: shell.avatarImageUrl,
    joinPolicy: shell.joinPolicy,
    memberCount: shell.memberCount,
    viewerMembership: shell.viewerMembership,
    viewerPendingApproval: shell.viewerPendingApproval,
  };
}

/**
 * Days an invitee must wait after declining a community group invite before
 * the same group can re-invite them. Tunable here so the UI hint text and the
 * server check stay in sync.
 */
export const COMMUNITY_GROUP_INVITE_REINVITE_AFTER_DECLINE_DAYS = 30;

/**
 * Hours we wait between (re)notifying a single invitee about a still-pending
 * invite from the same group. Re-issuing inside this window silently touches
 * the row instead of pinging the user again.
 */
export const COMMUNITY_GROUP_INVITE_RENOTIFY_AFTER_HOURS = 72;

/**
 * Days after issuance a community group invite expires (stays pending in the
 * inbox until then; flipped to `expired` by a cleanup job).
 */
export const COMMUNITY_GROUP_INVITE_EXPIRY_DAYS = 30;

/**
 * Lightweight reference to the group on a CommunityGroupInviteDto. Excludes
 * member counts/policy details that the inbox UI does not need.
 */
export type CommunityGroupInviteGroupRefDto = {
  id: string;
  slug: string;
  name: string;
  descriptionPreview: string;
  avatarImageUrl: string | null;
  coverImageUrl: string | null;
  joinPolicy: CommunityGroupJoinPolicy;
  memberCount: number;
};

export type CommunityGroupInviteDto = {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  status: CommunityGroupInviteStatus;
  message: string | null;
  /** ISO; only set when the invitee previously declined this same row. */
  lastDeclinedAt: string | null;
  group: CommunityGroupInviteGroupRefDto;
  invitedBy: UserListDto;
  invitee: UserListDto;
};

export function toCommunityGroupInviteGroupRefDto(g: CommunityGroup): CommunityGroupInviteGroupRefDto {
  const raw = (g.description ?? '').replace(/\s+/g, ' ').trim();
  const descriptionPreview =
    raw.length <= PREVIEW_DESC_LEN ? raw : `${raw.slice(0, PREVIEW_DESC_LEN - 1)}…`;
  return {
    id: g.id,
    slug: g.slug,
    name: g.name,
    descriptionPreview,
    avatarImageUrl: g.avatarImageUrl ?? null,
    coverImageUrl: g.coverImageUrl ?? null,
    joinPolicy: g.joinPolicy,
    memberCount: g.memberCount,
  };
}

export function toCommunityGroupInviteDto(params: {
  invite: CommunityGroupInvite & {
    group: CommunityGroup;
    invitedBy: UserListRow;
    invitee: UserListRow;
  };
  publicBaseUrl: string | null;
}): CommunityGroupInviteDto {
  const { invite, publicBaseUrl } = params;
  return {
    id: invite.id,
    createdAt: invite.createdAt.toISOString(),
    updatedAt: invite.updatedAt.toISOString(),
    expiresAt: invite.expiresAt.toISOString(),
    status: invite.status,
    message: invite.message,
    lastDeclinedAt: invite.lastDeclinedAt ? invite.lastDeclinedAt.toISOString() : null,
    group: toCommunityGroupInviteGroupRefDto(invite.group),
    invitedBy: toUserListDto(invite.invitedBy, publicBaseUrl),
    invitee: toUserListDto(invite.invitee, publicBaseUrl),
  };
}

/**
 * Rich invite-status hint returned by the picker so the inviter UI can render
 * "Already a member", "Pending invite", "Declined — try again on Mar 14", etc.
 */
export type CommunityGroupInvitableUserStatus =
  | { kind: 'invitable' }
  | { kind: 'self' }
  | { kind: 'banned' }
  | { kind: 'member'; role: CommunityGroupMemberRole }
  | { kind: 'pending_join_request' }
  | { kind: 'pending_invite'; inviteId: string; lastNotifiedAt: string | null }
  | { kind: 'declined_cooldown'; inviteId: string; declinedAt: string; canReinviteAt: string }
  | { kind: 'declined_invitable'; inviteId: string; declinedAt: string };

export type CommunityGroupInvitableUserDto = {
  user: UserListDto;
  inviteStatus: CommunityGroupInvitableUserStatus;
};

export function toCommunityGroupShellDto(
  g: CommunityGroup,
  viewerMembership: { status: CommunityGroupMemberStatus; role: CommunityGroupMemberRole } | null,
): CommunityGroupShellDto {
  const pending = viewerMembership?.status === 'pending';
  return {
    id: g.id,
    slug: g.slug,
    name: g.name,
    description: g.description,
    rules: g.rules ?? null,
    coverImageUrl: g.coverImageUrl ?? null,
    avatarImageUrl: g.avatarImageUrl ?? null,
    joinPolicy: g.joinPolicy,
    memberCount: g.memberCount,
    isFeatured: g.isFeatured,
    featuredOrder: g.featuredOrder,
    createdAt: g.createdAt.toISOString(),
    viewerMembership: viewerMembership && viewerMembership.status === 'active' ? viewerMembership : null,
    viewerPendingApproval: pending,
  };
}
