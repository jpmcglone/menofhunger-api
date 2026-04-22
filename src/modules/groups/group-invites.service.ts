import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type CommunityGroupMemberRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { toUserListDto, type UserListRow } from '../../common/dto/user.dto';
import {
  COMMUNITY_GROUP_INVITE_EXPIRY_DAYS,
  COMMUNITY_GROUP_INVITE_REINVITE_AFTER_DECLINE_DAYS,
  COMMUNITY_GROUP_INVITE_RENOTIFY_AFTER_HOURS,
  toCommunityGroupInviteDto,
  type CommunityGroupInvitableUserDto,
  type CommunityGroupInvitableUserStatus,
  type CommunityGroupInviteDto,
} from '../../common/dto/community-group.dto';

const INVITE_INCLUDE = {
  group: true,
  invitedBy: { select: USER_LIST_SELECT },
  invitee: { select: USER_LIST_SELECT },
} satisfies Prisma.CommunityGroupInviteInclude;

type InviteWithRelations = Prisma.CommunityGroupInviteGetPayload<{ include: typeof INVITE_INCLUDE }>;

@Injectable()
export class GroupInvitesService {
  private readonly logger = new Logger(GroupInvitesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------- internals ----------

  private expiryDate(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + COMMUNITY_GROUP_INVITE_EXPIRY_DAYS);
    return d;
  }

  private toDto(invite: InviteWithRelations): CommunityGroupInviteDto {
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return toCommunityGroupInviteDto({ invite, publicBaseUrl });
  }

  /**
   * Owners and moderators may issue invites — same gate used by other admin
   * actions (approve/reject/promote). Throws ForbiddenException otherwise and
   * returns the inviter's role so downstream code can branch on it.
   */
  private async assertModOrOwner(
    groupId: string,
    userId: string,
  ): Promise<CommunityGroupMemberRole> {
    const mem = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: { role: true, status: true },
    });
    if (!mem || mem.status !== 'active') {
      throw new ForbiddenException('Only group owners and moderators can invite members.');
    }
    if (mem.role !== 'owner' && mem.role !== 'moderator') {
      throw new ForbiddenException('Only group owners and moderators can invite members.');
    }
    return mem.role;
  }

  /**
   * Compute when an invitee that previously declined this same row may be
   * re-invited (preserves `lastDeclinedAt` for UI hint).
   */
  private canReinviteAt(declinedAt: Date): Date {
    const d = new Date(declinedAt);
    d.setUTCDate(d.getUTCDate() + COMMUNITY_GROUP_INVITE_REINVITE_AFTER_DECLINE_DAYS);
    return d;
  }

  private renotifyDueAt(lastNotifiedAt: Date): Date {
    const d = new Date(lastNotifiedAt);
    d.setUTCHours(d.getUTCHours() + COMMUNITY_GROUP_INVITE_RENOTIFY_AFTER_HOURS);
    return d;
  }

  // ---------- read ----------

  /** Pending invites the viewer has issued and any other pending invites for this group (owner/mod view). */
  async listGroupInvites(params: {
    viewerUserId: string;
    groupId: string;
  }): Promise<CommunityGroupInviteDto[]> {
    await this.assertModOrOwner(params.groupId, params.viewerUserId);
    const rows = await this.prisma.communityGroupInvite.findMany({
      where: { groupId: params.groupId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      include: INVITE_INCLUDE,
    });
    return rows.map((r) => this.toDto(r));
  }

  /** Pending group invites for the viewer's own inbox. */
  async listMyInbox(params: { viewerUserId: string }): Promise<CommunityGroupInviteDto[]> {
    const rows = await this.prisma.communityGroupInvite.findMany({
      where: {
        inviteeUserId: params.viewerUserId,
        status: 'pending',
        expiresAt: { gt: new Date() },
        group: { deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      include: INVITE_INCLUDE,
    });
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Search/lookup users the inviter could add to this group. Annotates each
   * user with an `inviteStatus` so the picker UI can hint at things like
   * "Already a member", "Pending invite", or "Declined — try again on Mar 14".
   * Excludes banned users from results entirely.
   */
  async listInvitableUsers(params: {
    viewerUserId: string;
    groupId: string;
    q: string | null;
    limit?: number;
  }): Promise<{ data: CommunityGroupInvitableUserDto[] }> {
    await this.assertModOrOwner(params.groupId, params.viewerUserId);
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
    const q = (params.q ?? '').trim();

    const userWhere: Prisma.UserWhereInput = {
      bannedAt: null,
      ...(q.length > 0
        ? {
            OR: [
              { username: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const users = await this.prisma.user.findMany({
      where: userWhere,
      orderBy: q.length > 0 ? [{ username: 'asc' }] : [{ createdAt: 'desc' }],
      select: USER_LIST_SELECT,
      take: limit,
    });
    if (users.length === 0) return { data: [] };

    const userIds = users.map((u) => u.id);
    const [memberships, invites] = await Promise.all([
      this.prisma.communityGroupMember.findMany({
        where: { groupId: params.groupId, userId: { in: userIds } },
        select: { userId: true, status: true, role: true },
      }),
      this.prisma.communityGroupInvite.findMany({
        where: {
          groupId: params.groupId,
          inviteeUserId: { in: userIds },
          status: { in: ['pending', 'declined'] },
        },
        select: {
          id: true,
          inviteeUserId: true,
          status: true,
          lastNotifiedAt: true,
          lastDeclinedAt: true,
          respondedAt: true,
        },
      }),
    ]);
    const membershipByUser = new Map(memberships.map((m) => [m.userId, m] as const));
    const inviteByUser = new Map(invites.map((i) => [i.inviteeUserId, i] as const));
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const now = Date.now();

    const data: CommunityGroupInvitableUserDto[] = users.map((u) => {
      const userDto = toUserListDto(u as UserListRow, publicBaseUrl);
      let status: CommunityGroupInvitableUserStatus;
      if (u.id === params.viewerUserId) {
        status = { kind: 'self' };
      } else if (u.bannedAt) {
        status = { kind: 'banned' };
      } else {
        const mem = membershipByUser.get(u.id);
        if (mem && mem.status === 'active') {
          status = { kind: 'member', role: mem.role };
        } else if (mem && mem.status === 'pending') {
          status = { kind: 'pending_join_request' };
        } else {
          const inv = inviteByUser.get(u.id);
          if (inv && inv.status === 'pending') {
            status = {
              kind: 'pending_invite',
              inviteId: inv.id,
              lastNotifiedAt: inv.lastNotifiedAt ? inv.lastNotifiedAt.toISOString() : null,
            };
          } else if (inv && inv.status === 'declined') {
            const declinedAt = inv.lastDeclinedAt ?? inv.respondedAt;
            if (declinedAt) {
              const reinviteAt = this.canReinviteAt(declinedAt);
              if (reinviteAt.getTime() > now) {
                status = {
                  kind: 'declined_cooldown',
                  inviteId: inv.id,
                  declinedAt: declinedAt.toISOString(),
                  canReinviteAt: reinviteAt.toISOString(),
                };
              } else {
                status = {
                  kind: 'declined_invitable',
                  inviteId: inv.id,
                  declinedAt: declinedAt.toISOString(),
                };
              }
            } else {
              status = { kind: 'invitable' };
            }
          } else {
            status = { kind: 'invitable' };
          }
        }
      }
      return { user: userDto, inviteStatus: status };
    });
    return { data };
  }

  // ---------- write ----------

  /**
   * Issue or refresh an invite to `inviteeUserId` for `groupId`. Behavior by
   * pre-existing invite state on the same (group, invitee) row:
   *
   *   - none / accepted / cancelled / expired → create a fresh invite row.
   *   - pending → reuse the row. If the inviter changed (or
   *     `COMMUNITY_GROUP_INVITE_RENOTIFY_AFTER_HOURS` has passed since the
   *     last notification), update inviter/note + re-notify the invitee with
   *     a re-marked-unread notification. Otherwise silently update inviter +
   *     note (no second ping during the cooldown window).
   *   - declined → block until
   *     `COMMUNITY_GROUP_INVITE_REINVITE_AFTER_DECLINE_DAYS` have elapsed
   *     since the decline; afterward, reset the row to `pending` (preserving
   *     `lastDeclinedAt` for the picker UI) and notify.
   */
  async sendInvite(params: {
    viewerUserId: string;
    groupId: string;
    inviteeUserId: string;
    message?: string | null;
  }): Promise<{ invite: CommunityGroupInviteDto; resent: boolean; notified: boolean }> {
    await this.assertModOrOwner(params.groupId, params.viewerUserId);
    const inviteeId = (params.inviteeUserId ?? '').trim();
    if (!inviteeId) throw new BadRequestException('Invitee is required.');
    if (inviteeId === params.viewerUserId) {
      throw new BadRequestException('You cannot invite yourself.');
    }

    const group = await this.prisma.communityGroup.findFirst({
      where: { id: params.groupId, deletedAt: null },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Group not found.');

    const invitee = await this.prisma.user.findUnique({
      where: { id: inviteeId },
      select: { id: true, bannedAt: true },
    });
    if (!invitee || invitee.bannedAt) {
      throw new NotFoundException('User not found.');
    }

    const existingMember = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: params.groupId, userId: inviteeId } },
      select: { status: true, role: true },
    });
    if (existingMember && existingMember.status === 'active') {
      throw new ConflictException('That person is already a member of this group.');
    }
    if (existingMember && existingMember.status === 'pending') {
      throw new ConflictException(
        'That person already has a pending join request — approve them instead.',
      );
    }

    const trimmedNote = (params.message ?? '').trim().slice(0, 500) || null;
    const existing = await this.prisma.communityGroupInvite.findUnique({
      where: {
        groupId_inviteeUserId: { groupId: params.groupId, inviteeUserId: inviteeId },
      },
    });

    const now = new Date();
    let inviteRow: InviteWithRelations;
    let isFreshIssue = false;
    let shouldNotify = false;

    if (!existing) {
      inviteRow = await this.prisma.communityGroupInvite.create({
        data: {
          groupId: params.groupId,
          invitedByUserId: params.viewerUserId,
          inviteeUserId: inviteeId,
          message: trimmedNote,
          expiresAt: this.expiryDate(),
        },
        include: INVITE_INCLUDE,
      });
      isFreshIssue = true;
      shouldNotify = true;
    } else if (existing.status === 'declined') {
      const declinedAt = existing.lastDeclinedAt ?? existing.respondedAt ?? existing.updatedAt;
      const reinviteAt = this.canReinviteAt(declinedAt);
      if (reinviteAt.getTime() > now.getTime()) {
        throw new ForbiddenException(
          `That person declined recently. You can invite them again on ${reinviteAt.toISOString()}.`,
        );
      }
      inviteRow = await this.prisma.communityGroupInvite.update({
        where: { id: existing.id },
        data: {
          invitedByUserId: params.viewerUserId,
          message: trimmedNote,
          status: 'pending',
          expiresAt: this.expiryDate(),
          respondedAt: null,
          lastDeclinedAt: declinedAt,
          lastNotifiedAt: null,
        },
        include: INVITE_INCLUDE,
      });
      isFreshIssue = true;
      shouldNotify = true;
    } else if (existing.status === 'pending') {
      const inviterChanged = existing.invitedByUserId !== params.viewerUserId;
      const noteChanged = (existing.message ?? null) !== trimmedNote;
      const lastNotified = existing.lastNotifiedAt;
      const cooledDown =
        !lastNotified || this.renotifyDueAt(lastNotified).getTime() <= now.getTime();
      shouldNotify = inviterChanged || cooledDown;
      inviteRow = await this.prisma.communityGroupInvite.update({
        where: { id: existing.id },
        data: {
          invitedByUserId: params.viewerUserId,
          message: trimmedNote,
          expiresAt: this.expiryDate(),
        },
        include: INVITE_INCLUDE,
      });
      isFreshIssue = false;
      if (!shouldNotify) {
        // Silent touch within the cooldown window.
        this.logger.debug(
          `[group-invites] silent re-issue (cooldown) group=${params.groupId} invitee=${inviteeId}`,
        );
      }
      if (noteChanged && !shouldNotify) {
        this.logger.debug(
          `[group-invites] note changed but suppressed re-notify due to cooldown group=${params.groupId} invitee=${inviteeId}`,
        );
      }
    } else {
      // accepted / cancelled / expired — create a fresh invite row by way of an in-place
      // update (uniqueness on [groupId, inviteeUserId] forbids a second row).
      inviteRow = await this.prisma.communityGroupInvite.update({
        where: { id: existing.id },
        data: {
          invitedByUserId: params.viewerUserId,
          message: trimmedNote,
          status: 'pending',
          expiresAt: this.expiryDate(),
          respondedAt: null,
          lastNotifiedAt: null,
        },
        include: INVITE_INCLUDE,
      });
      isFreshIssue = true;
      shouldNotify = true;
    }

    if (shouldNotify) {
      const result = await this.notifications.upsertCommunityGroupInviteReceivedNotification({
        inviteeUserId: inviteeId,
        inviterUserId: params.viewerUserId,
        groupId: params.groupId,
        inviteId: inviteRow.id,
        bodySnippet: trimmedNote ? trimmedNote.slice(0, 200) : null,
      });
      if (result.notified) {
        await this.prisma.communityGroupInvite.update({
          where: { id: inviteRow.id },
          data: { lastNotifiedAt: new Date() },
        });
        inviteRow = { ...inviteRow, lastNotifiedAt: new Date() };
      }
    }

    const dto = this.toDto(inviteRow);
    this.presenceRealtime.emitGroupInviteReceived(inviteeId, { invite: dto });
    this.presenceRealtime.emitGroupInviteUpdated([params.viewerUserId], { invite: dto });

    return { invite: dto, resent: !isFreshIssue, notified: shouldNotify };
  }

  /** Cancel a pending invite (any owner/moderator can cancel). Idempotent. */
  async cancelInvite(params: {
    viewerUserId: string;
    groupId: string;
    inviteId: string;
  }): Promise<void> {
    await this.assertModOrOwner(params.groupId, params.viewerUserId);
    const invite = await this.prisma.communityGroupInvite.findUnique({
      where: { id: params.inviteId },
    });
    if (!invite || invite.groupId !== params.groupId) {
      throw new NotFoundException('Invite not found.');
    }
    if (invite.status !== 'pending') return;
    const updated = await this.prisma.communityGroupInvite.update({
      where: { id: invite.id },
      data: { status: 'cancelled', respondedAt: new Date() },
      include: INVITE_INCLUDE,
    });
    const dto = this.toDto(updated);
    await this.notifications.create({
      recipientUserId: invite.inviteeUserId,
      kind: 'community_group_invite_cancelled',
      actorUserId: params.viewerUserId,
      subjectGroupId: invite.groupId,
      subjectCommunityGroupInviteId: invite.id,
    });
    this.presenceRealtime.emitGroupInviteUpdated(
      [invite.invitedByUserId, invite.inviteeUserId, params.viewerUserId],
      { invite: dto },
    );
  }

  /** Invitee declines a pending invite. Stamps `lastDeclinedAt` for cooldown. */
  async declineInvite(params: {
    viewerUserId: string;
    inviteId: string;
  }): Promise<void> {
    const invite = await this.prisma.communityGroupInvite.findUnique({
      where: { id: params.inviteId },
    });
    if (!invite) throw new NotFoundException('Invite not found.');
    if (invite.inviteeUserId !== params.viewerUserId) {
      throw new ForbiddenException('You can only respond to invites sent to you.');
    }
    if (invite.status !== 'pending') return;
    const now = new Date();
    const updated = await this.prisma.communityGroupInvite.update({
      where: { id: invite.id },
      data: { status: 'declined', respondedAt: now, lastDeclinedAt: now },
      include: INVITE_INCLUDE,
    });
    await this.notifications.upsertCommunityGroupInviteResponseNotification({
      inviterUserId: invite.invitedByUserId,
      inviteeUserId: invite.inviteeUserId,
      groupId: invite.groupId,
      inviteId: invite.id,
      response: 'declined',
    });
    const dto = this.toDto(updated);
    this.presenceRealtime.emitGroupInviteUpdated(
      [invite.invitedByUserId, invite.inviteeUserId],
      { invite: dto },
    );
  }

  /** Invitee accepts; joins the group as `member` immediately (skips approval). */
  async acceptInvite(params: {
    viewerUserId: string;
    inviteId: string;
  }): Promise<{ groupId: string; groupSlug: string }> {
    const invite = await this.prisma.communityGroupInvite.findUnique({
      where: { id: params.inviteId },
    });
    if (!invite) throw new NotFoundException('Invite not found.');
    if (invite.inviteeUserId !== params.viewerUserId) {
      throw new ForbiddenException('You can only accept your own invites.');
    }
    if (invite.status !== 'pending') {
      throw new BadRequestException('Invite is no longer pending.');
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      await this.prisma.communityGroupInvite.update({
        where: { id: invite.id },
        data: { status: 'expired', respondedAt: new Date() },
      });
      throw new BadRequestException('This invite has expired.');
    }

    const group = await this.prisma.communityGroup.findFirst({
      where: { id: invite.groupId, deletedAt: null },
      select: { id: true, slug: true },
    });
    if (!group) {
      await this.prisma.communityGroupInvite.update({
        where: { id: invite.id },
        data: { status: 'cancelled', respondedAt: new Date() },
      });
      throw new NotFoundException('Group no longer exists.');
    }

    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        // Existing membership row (e.g. previously rejected approval request) — promote it.
        const existingMember = await tx.communityGroupMember.findUnique({
          where: { groupId_userId: { groupId: invite.groupId, userId: params.viewerUserId } },
        });
        if (existingMember && existingMember.status === 'active') {
          // Already a member; just resolve the invite.
        } else if (existingMember) {
          await tx.communityGroupMember.update({
            where: { groupId_userId: { groupId: invite.groupId, userId: params.viewerUserId } },
            data: { status: 'active', role: 'member' },
          });
          await tx.communityGroup.update({
            where: { id: invite.groupId },
            data: { memberCount: { increment: 1 } },
          });
        } else {
          await tx.communityGroupMember.create({
            data: {
              groupId: invite.groupId,
              userId: params.viewerUserId,
              role: 'member',
              status: 'active',
            },
          });
          await tx.communityGroup.update({
            where: { id: invite.groupId },
            data: { memberCount: { increment: 1 } },
          });
        }
        await tx.communityGroupInvite.update({
          where: { id: invite.id },
          data: { status: 'accepted', respondedAt: now },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('You are already a member of this group.');
      }
      throw e;
    }

    await this.notifications.upsertCommunityGroupInviteResponseNotification({
      inviterUserId: invite.invitedByUserId,
      inviteeUserId: invite.inviteeUserId,
      groupId: invite.groupId,
      inviteId: invite.id,
      response: 'accepted',
    });

    const updated = await this.prisma.communityGroupInvite.findUniqueOrThrow({
      where: { id: invite.id },
      include: INVITE_INCLUDE,
    });
    const dto = this.toDto(updated);
    this.presenceRealtime.emitGroupInviteUpdated(
      [invite.invitedByUserId, invite.inviteeUserId],
      { invite: dto },
    );

    return { groupId: group.id, groupSlug: group.slug };
  }

  // ---------- expiry job ----------

  /** Flip pending invites past expiry. Returns how many rows changed. */
  async expirePendingInvites(): Promise<number> {
    const now = new Date();
    const expiring = await this.prisma.communityGroupInvite.findMany({
      where: { status: 'pending', expiresAt: { lte: now } },
      select: { id: true, invitedByUserId: true, inviteeUserId: true, groupId: true },
      take: 500,
    });
    if (expiring.length === 0) return 0;
    const ids = expiring.map((e) => e.id);
    const result = await this.prisma.communityGroupInvite.updateMany({
      where: { id: { in: ids }, status: 'pending' },
      data: { status: 'expired', respondedAt: now },
    });
    for (const row of expiring) {
      this.presenceRealtime.emitGroupInviteUpdated(
        [row.invitedByUserId, row.inviteeUserId],
        { invite: { id: row.id, status: 'expired' } },
      );
    }
    return result.count;
  }
}
