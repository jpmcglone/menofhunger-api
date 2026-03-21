import type {
  CommunityGroup,
  CommunityGroupJoinPolicy,
  CommunityGroupMemberRole,
  CommunityGroupMemberStatus,
} from '@prisma/client';

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
