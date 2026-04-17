import type { Crew, CrewInvite, CrewInviteStatus, CrewMember, CrewMemberRole } from '@prisma/client';
import { toUserListDto, type UserListDto, type UserListRow } from './user.dto';

/**
 * Public-facing Crew shell (shown on /c/:slug, profile crew pill, etc.).
 * Does NOT include anything private (wall contents, invite list, etc.).
 */
export type CrewPublicDto = {
  id: string;
  slug: string;
  /** null means "Untitled Crew" — renderers should display the friendly fallback. */
  name: string | null;
  tagline: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  memberCount: number;
  createdAt: string;
  owner: UserListDto;
  members: CrewMemberListItemDto[];
};

/**
 * Private Crew shell (returned from GET /crew/me to members only).
 * Includes wall conversation id and viewer-specific metadata.
 */
export type CrewPrivateDto = CrewPublicDto & {
  wallConversationId: string;
  designatedSuccessorUserId: string | null;
  viewerRole: CrewMemberRole;
  pendingInviteCount: number;
};

/**
 * Crew member list row. Embeds the full `UserListDto` so renderers can show
 * verified checks, premium tints, org affiliations, etc. without an extra fetch.
 */
export type CrewMemberListItemDto = {
  user: UserListDto;
  role: CrewMemberRole;
  joinedAt: string;
  isDesignatedSuccessor: boolean;
};

export type CrewInviteDto = {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: CrewInviteStatus;
  message: string | null;
  /** Null for founding invites (the crew does not exist yet). */
  crew: CrewPublicDto | null;
  invitedBy: UserListDto;
  invitee: UserListDto;
};

export function crewAvatarUrl(
  crew: Pick<Crew, 'avatarImageUrl'>,
  _publicBaseUrl: string | null,
): string | null {
  // Avatar is stored as a full URL (avatarImageUrl) in the schema; keep it simple.
  const v = (crew.avatarImageUrl ?? '').trim();
  return v || null;
}

export function crewCoverUrl(
  crew: Pick<Crew, 'coverImageUrl'>,
  _publicBaseUrl: string | null,
): string | null {
  const v = (crew.coverImageUrl ?? '').trim();
  return v || null;
}

export function toCrewMemberListItemDto(
  row: CrewMember & { user: UserListRow },
  opts: { publicBaseUrl: string | null; designatedSuccessorUserId: string | null },
): CrewMemberListItemDto {
  return {
    user: toUserListDto(row.user, opts.publicBaseUrl),
    role: row.role,
    joinedAt: row.createdAt.toISOString(),
    isDesignatedSuccessor: row.userId === opts.designatedSuccessorUserId,
  };
}

export function toCrewPublicDto(params: {
  crew: Crew;
  ownerRow: UserListRow;
  memberRows: (CrewMember & { user: UserListRow })[];
  publicBaseUrl: string | null;
}): CrewPublicDto {
  const { crew, ownerRow, memberRows, publicBaseUrl } = params;
  return {
    id: crew.id,
    slug: crew.slug,
    name: crew.name,
    tagline: crew.tagline,
    bio: crew.bio,
    avatarUrl: crewAvatarUrl(crew, publicBaseUrl),
    coverUrl: crewCoverUrl(crew, publicBaseUrl),
    memberCount: crew.memberCount,
    createdAt: crew.createdAt.toISOString(),
    owner: toUserListDto(ownerRow, publicBaseUrl),
    members: memberRows
      .map((m) => toCrewMemberListItemDto(m, { publicBaseUrl, designatedSuccessorUserId: crew.designatedSuccessorUserId }))
      .sort((a, b) => {
        // Owner always first, then by join order (earliest first).
        if (a.role === 'owner' && b.role !== 'owner') return -1;
        if (b.role === 'owner' && a.role !== 'owner') return 1;
        return a.joinedAt.localeCompare(b.joinedAt);
      }),
  };
}

export function toCrewPrivateDto(params: {
  crew: Crew;
  ownerRow: UserListRow;
  memberRows: (CrewMember & { user: UserListRow })[];
  publicBaseUrl: string | null;
  viewerRole: CrewMemberRole;
  pendingInviteCount: number;
}): CrewPrivateDto {
  const base = toCrewPublicDto({
    crew: params.crew,
    ownerRow: params.ownerRow,
    memberRows: params.memberRows,
    publicBaseUrl: params.publicBaseUrl,
  });
  return {
    ...base,
    wallConversationId: params.crew.wallConversationId,
    designatedSuccessorUserId: params.crew.designatedSuccessorUserId,
    viewerRole: params.viewerRole,
    pendingInviteCount: params.pendingInviteCount,
  };
}

export function toCrewInviteDto(params: {
  invite: CrewInvite & {
    crew: (Crew & { owner: UserListRow; members: (CrewMember & { user: UserListRow })[] }) | null;
    invitedBy: UserListRow;
    invitee: UserListRow;
  };
  publicBaseUrl: string | null;
}): CrewInviteDto {
  const { invite, publicBaseUrl } = params;
  return {
    id: invite.id,
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt.toISOString(),
    status: invite.status,
    message: invite.message,
    crew: invite.crew
      ? toCrewPublicDto({
          crew: invite.crew,
          ownerRow: invite.crew.owner,
          memberRows: invite.crew.members,
          publicBaseUrl,
        })
      : null,
    invitedBy: toUserListDto(invite.invitedBy, publicBaseUrl),
    invitee: toUserListDto(invite.invitee, publicBaseUrl),
  };
}

/** Hard member cap (including the owner). */
export const CREW_MEMBER_CAP = 5;

/** Invites expire after 14 days. */
export const CREW_INVITE_EXPIRY_DAYS = 14;

/** Owner transfer votes expire after 7 days. */
export const CREW_TRANSFER_VOTE_EXPIRY_DAYS = 7;

/** Auto-transfer threshold when the owner is inactive. */
export const CREW_INACTIVE_OWNER_DAYS = 30;
