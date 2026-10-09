import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { CommunityGroupMemberRole } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { assertGroupRole, getGroupMemberOrThrow, GROUP_MANAGER_ROLES } from '../viewer/group-membership.queries';
import { prepareChannelDeparture, emitChannelAccessChange } from '../group-channels/channel-lifecycle';
import { transferGroupOwnership } from './group-ownership';
import { toAvatarVideoDto } from '../../common/dto/avatar-video.dto';
import { type CommunityGroupMemberListItemDto } from '../../common/dto/community-group.dto';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { toPage } from '../../common/pagination/page';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { MarvinBotIdentityService } from '../marvin/services/marvin-bot-identity.service';
import { NOT_DELETED } from '../../common/prisma/where';

/** Group membership moderation: pending requests, removals, roles, ownership transfer, member listing. */
@Injectable()
export class GroupMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly sideEffects: SideEffectsService,
    private readonly marvIdentity: MarvinBotIdentityService,
    private readonly presenceRealtime: PresenceRealtimeService,
  ) {}

  async assertActiveMember(groupId: string, userId: string): Promise<void> {
    await getGroupMemberOrThrow(this.prisma, groupId, userId);
  }

  private async assertModOrOwner(groupId: string, userId: string): Promise<CommunityGroupMemberRole> {
    return assertGroupRole(this.prisma, groupId, userId, GROUP_MANAGER_ROLES);
  }

  async listPending(params: { viewerUserId: string; groupId: string }) {
    await this.assertModOrOwner(params.groupId, params.viewerUserId);
    const rows = await this.prisma.communityGroupMember.findMany({
      where: { groupId: params.groupId, status: 'pending' },
      include: { user: { select: { ...USER_LIST_SELECT, username: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      data: rows.map((r) => ({
        userId: r.userId,
        username: r.user.username,
        name: r.user.name,
        requestedAt: r.createdAt.toISOString(),
      })),
    };
  }

  async approveMember(params: { viewerUserId: string; groupId: string; userId: string }) {
    await this.assertModOrOwner(params.groupId, params.viewerUserId);
    const target = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: params.groupId, userId: params.userId } },
    });
    if (!target || target.status !== 'pending') throw new NotFoundException('No pending request for this user.');

    await this.prisma.$transaction(async (tx) => {
      await tx.communityGroupMember.update({
        where: { groupId_userId: { groupId: params.groupId, userId: params.userId } },
        data: { status: 'active', role: 'member' },
      });
      await tx.communityGroup.update({
        where: { id: params.groupId },
        data: { memberCount: { increment: 1 } },
      });
    });

    // Notifies the approved user, then fans member-joined out to the existing members.
    this.sideEffects.dispatch('group.join.decided', {
      groupId: params.groupId,
      userId: params.userId,
      actorUserId: params.viewerUserId,
      decision: 'approved',
    });
    this.sideEffects.dispatch('channel.member.joined', {
      groupId: params.groupId,
      userId: params.userId,
      at: new Date().toISOString(),
    });

    return { data: { ok: true as const } };
  }

  async rejectMember(params: { viewerUserId: string; groupId: string; userId: string }) {
    await this.assertModOrOwner(params.groupId, params.viewerUserId);
    const target = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: params.groupId, userId: params.userId } },
    });
    if (!target || target.status !== 'pending') throw new NotFoundException('No pending request for this user.');

    await this.prisma.communityGroupMember.delete({
      where: { groupId_userId: { groupId: params.groupId, userId: params.userId } },
    });

    this.sideEffects.dispatch('group.join.decided', {
      groupId: params.groupId,
      userId: params.userId,
      actorUserId: params.viewerUserId,
      decision: 'rejected',
    });

    return { data: { ok: true as const } };
  }

  async removeMember(params: { viewerUserId: string; groupId: string; userId: string }) {
    const actorRole = await this.assertModOrOwner(params.groupId, params.viewerUserId);
    if (params.userId === params.viewerUserId) throw new BadRequestException('Use leave to remove yourself.');

    const target = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: params.groupId, userId: params.userId } },
    });
    if (!target || target.status !== 'active') throw new NotFoundException('Member not found.');

    if (target.role === 'owner') throw new ForbiddenException('Cannot remove the owner.');
    if (target.role === 'moderator' && actorRole !== 'owner') {
      throw new ForbiddenException('Only the owner can remove a moderator.');
    }

    await this.prisma.$transaction(async (tx) => {
      await prepareChannelDeparture(tx, params.groupId, params.userId, { forced: true });
      const actor = await tx.communityGroupMember.findUnique({ where: { groupId_userId: { groupId: params.groupId, userId: params.viewerUserId } } });
      const current = await tx.communityGroupMember.findUnique({ where: { groupId_userId: { groupId: params.groupId, userId: params.userId } } });
      if (!actor || actor.status !== 'active' || !['owner', 'moderator'].includes(actor.role) || !current || current.role === 'owner' || (current.role === 'moderator' && actor.role !== 'owner')) throw new ForbiddenException('You cannot remove this member.');

      await tx.communityGroupMember.delete({
        where: { groupId_userId: { groupId: params.groupId, userId: params.userId } },
      });
      await tx.communityGroup.update({
        where: { id: params.groupId },
        data: { memberCount: { decrement: 1 } },
      });
    });

    await emitChannelAccessChange(this.prisma, this.presenceRealtime, params.groupId, params.userId);

    // Skip the notification if the removed user is the Marv bot — he's a machine; sending him
    // a "you were removed" push is meaningless.
    const marvId = this.marvIdentity.cachedMarvUserId();
    if (params.userId !== marvId) {
      this.sideEffects.dispatch('group.member.removed', {
        groupId: params.groupId,
        userId: params.userId,
        actorUserId: params.viewerUserId,
      });
    } else {
      // Marv was removed — broadcast so other mods' settings pages update live.
      this.presenceRealtime.emitGroupMarvChanged(params.groupId, { groupId: params.groupId, isMember: false });
    }

    return { data: { ok: true as const } };
  }

  /**
   * Add Marv as an active member of a group, bypassing the normal invite flow.
   * Owner/mod gated. Idempotent — if Marv is already an active member, returns ok.
   * Any existing invite row for Marv in this group is transitioned to `accepted`.
   */
  async addMarvToGroup(params: { viewerUserId: string; groupId: string }) {
    await this.assertModOrOwner(params.groupId, params.viewerUserId);

    const group = await this.prisma.communityGroup.findFirst({
      where: { id: params.groupId, ...NOT_DELETED },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Group not found.');

    const marvId = await this.marvIdentity.getMarvUserId();
    if (!marvId) throw new NotFoundException('Marv is not configured on this server.');

    // Upsert: create active member row; increment memberCount only when newly added.
    const existing = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: marvId } },
      select: { status: true },
    });

    if (existing?.status === 'active') {
      return { data: { ok: true as const } };
    }

    await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.communityGroupMember.update({
          where: { groupId_userId: { groupId: group.id, userId: marvId } },
          data: { status: 'active', role: 'member' },
        });
      } else {
        await tx.communityGroupMember.create({
          data: { groupId: group.id, userId: marvId, role: 'member', status: 'active' },
        });
        await tx.communityGroup.update({
          where: { id: group.id },
          data: { memberCount: { increment: 1 } },
        });
      }
      // Resolve any outstanding invite row for Marv.
      await tx.communityGroupInvite.updateMany({
        where: { groupId: group.id, inviteeUserId: marvId, status: 'pending' },
        data: { status: 'accepted', respondedAt: new Date() },
      });
    });

    this.presenceRealtime.emitGroupMarvChanged(group.id, { groupId: group.id, isMember: true });

    return { data: { ok: true as const } };
  }

  async promoteModerator(params: { viewerUserId: string; isSiteAdmin: boolean; groupId: string; userId: string }) {
    const group = await this.prisma.communityGroup.findFirst({
      where: { id: params.groupId, ...NOT_DELETED },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Group not found.');

    const mem = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: params.viewerUserId } },
      select: { role: true, status: true },
    });
    const isOwner = mem?.status === 'active' && mem.role === 'owner';
    if (!isOwner && !params.isSiteAdmin) {
      throw new ForbiddenException('Only the owner can promote moderators.');
    }

    const target = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: params.userId } },
    });
    if (!target || target.status !== 'active') throw new NotFoundException('Member not found.');
    if (target.role !== 'member') throw new BadRequestException('Only members can be promoted to moderator.');

    await this.prisma.communityGroupMember.update({
      where: { groupId_userId: { groupId: group.id, userId: params.userId } },
      data: { role: 'moderator' },
    });
    return { data: { ok: true as const } };
  }

  async transferOwnership(params: { viewerUserId: string; groupId: string; userId: string }) {
    await transferGroupOwnership(this.prisma, params.groupId, params.viewerUserId, params.userId);
    await emitChannelAccessChange(this.prisma, this.presenceRealtime, params.groupId, params.userId);
    return { data: { ok: true as const } };
  }

  async demoteModerator(params: { viewerUserId: string; isSiteAdmin: boolean; groupId: string; userId: string }) {
    const group = await this.prisma.communityGroup.findFirst({
      where: { id: params.groupId, ...NOT_DELETED },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Group not found.');

    const mem = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: params.viewerUserId } },
      select: { role: true, status: true },
    });
    const isOwner = mem?.status === 'active' && mem.role === 'owner';
    if (!isOwner && !params.isSiteAdmin) {
      throw new ForbiddenException('Only the owner can demote moderators.');
    }

    const target = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: params.userId } },
    });
    if (!target || target.status !== 'active' || target.role !== 'moderator') {
      throw new NotFoundException('Moderator not found.');
    }

    await this.prisma.$transaction(async tx => {
      await prepareChannelDeparture(tx, group.id, params.userId, { forced: false, demotion: true });
      const actor = await tx.communityGroupMember.findUnique({ where: { groupId_userId: { groupId: group.id, userId: params.viewerUserId } } });
      if (!params.isSiteAdmin && (actor?.status !== 'active' || actor.role !== 'owner')) throw new ForbiddenException('Only the owner can demote moderators.');
      const current = await tx.communityGroupMember.findUnique({ where: { groupId_userId: { groupId: group.id, userId: params.userId } } });
      if (current?.status !== 'active' || current.role !== 'moderator') throw new NotFoundException('Moderator not found.');
      await tx.communityGroupMember.update({ where: { groupId_userId: { groupId: group.id, userId: params.userId } }, data: { role: 'member' } });
    });
    await emitChannelAccessChange(this.prisma, this.presenceRealtime, group.id, params.userId);
    return { data: { ok: true as const } };
  }

  async listMembers(params: {
    viewerUserId: string;
    groupId: string;
    limit: number;
    cursor: string | null;
    q?: string | null;
  }): Promise<{ data: CommunityGroupMemberListItemDto[]; pagination: { nextCursor: string | null } }> {
    await this.assertActiveMember(params.groupId, params.viewerUserId);
    const q = (params.q ?? '').trim();
    const limit = Math.min(Math.max(params.limit ?? 30, 1), 50);

    const searchClause: Prisma.CommunityGroupMemberWhereInput | undefined =
      q.length > 0
        ? {
            OR: [
              { user: { username: { contains: q, mode: 'insensitive' } } },
              { user: { name: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : undefined;

    const cursorUserId = (params.cursor ?? '').trim();
    const cursorMember = cursorUserId
      ? await this.prisma.communityGroupMember.findUnique({
          where: { groupId_userId: { groupId: params.groupId, userId: cursorUserId } },
          select: { userId: true, createdAt: true, role: true },
        })
      : null;
    // Sort: owner first, then moderator, then member; within each role, earliest join first.
    // Cursor WHERE mirrors orderBy [role desc, createdAt asc, userId asc].
    // Prisma enum filters don't support lt/gt, so we enumerate the role values
    // that appear after the cursor in the desc sort (i.e. lower declaration rank).
    const ROLES_BY_RANK: CommunityGroupMemberRole[] = ['owner', 'moderator', 'member'];
    const rolesAfterCursor = cursorMember
      ? ROLES_BY_RANK.slice(ROLES_BY_RANK.indexOf(cursorMember.role) + 1)
      : [];
    const cursorWhere: Prisma.CommunityGroupMemberWhereInput | null = cursorMember
      ? {
          OR: [
            ...(rolesAfterCursor.length ? [{ role: { in: rolesAfterCursor } }] : []),
            {
              AND: [
                { role: cursorMember.role },
                { createdAt: { gt: cursorMember.createdAt } },
              ],
            },
            {
              AND: [
                { role: cursorMember.role },
                { createdAt: cursorMember.createdAt },
                { userId: { gt: cursorMember.userId } },
              ],
            },
          ],
        }
      : null;

    const andParts: Prisma.CommunityGroupMemberWhereInput[] = [];
    if (searchClause) andParts.push(searchClause);
    if (cursorWhere) andParts.push(cursorWhere);

    const rows = await this.prisma.communityGroupMember.findMany({
      where: {
        groupId: params.groupId,
        status: 'active',
        ...(andParts.length ? { AND: andParts } : {}),
      },
      include: { user: { select: USER_LIST_SELECT } },
      orderBy: [{ role: 'desc' }, { createdAt: 'asc' }, { userId: 'asc' }],
      take: limit + 1,
    });

    const r2 = this.appConfig.r2()?.publicBaseUrl ?? null;
    const { items: slice, nextCursor: nextCursor } = toPage(rows, limit, (r) => r.userId);

    const data: CommunityGroupMemberListItemDto[] = slice.map((m) => ({
      userId: m.userId,
      username: m.user.username,
      name: m.user.name,
      role: m.role,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: r2,
        key: m.user.avatarKey ?? null,
        updatedAt: m.user.avatarUpdatedAt ?? null,
      }), avatarVideo: toAvatarVideoDto(m.user, r2),
      joinedAt: m.createdAt.toISOString(),
    }));

    return { data, pagination: { nextCursor } };
  }
}
