import { assertGroupRole, getGroupMemberOrThrow, GROUP_MANAGER_ROLES } from '../viewer/group-membership.queries';
import { ChannelAccessService } from '../group-channels/channel-access.service';
import { prepareChannelDeparture, emitChannelAccessChange } from '../group-channels/channel-lifecycle';
import { provisionDefaultChannels } from '../group-channels/channel-provisioning';
import { transferGroupOwnership } from './group-ownership';
import { toAvatarVideoDto } from '../../common/dto/avatar-video.dto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CommunityGroupJoinPolicy, CommunityGroupMemberRole } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  toCommunityGroupShellDto,
  type CommunityGroupMemberListItemDto,
  type GroupNotificationPreferencesDto,
  type GroupActivityDto,
} from '../../common/dto/community-group.dto';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { PostsService } from '../posts/posts.service';
import { AppConfigService } from '../app/app-config.service';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { MarvinBotIdentityService } from '../marvin/services/marvin-bot-identity.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';

import { PostsReadService } from '../posts-read/posts-read.service';
import { PostsWriteService } from '../posts-read/posts-write.service';
import { searchGroupsOn } from './groups-search.query';
import { listExploreSpotlightOn } from './groups-explore.query';
import { slugifyHandle } from '../../common/text/slugify';
import { toPage } from '../../common/pagination/page';
const FEATURED_CACHE_TTL_SECONDS = 120;

@Injectable()
export class GroupsService {
  constructor(
    readonly prisma: PrismaService,
    readonly postsRead: PostsReadService,
    private readonly postsWrite: PostsWriteService,
    private readonly posts: PostsService,
    private readonly appConfig: AppConfigService,
    private readonly sideEffects: SideEffectsService,
    private readonly redis: RedisService,
    private readonly marvIdentity: MarvinBotIdentityService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly channelAccess?: ChannelAccessService,
  ) {}

  private async channelSummary(userId: string | null, groupId: string) {
    if (!userId || !this.channelAccess?.enabled(groupId)) return { channelsAvailable: false, channelPersonalCount: 0, channelHasUnread: false };
    try {
      await this.channelAccess.member(userId, groupId);
      const [channelPersonalCount, channelHasUnread] = await Promise.all([
        this.channelAccess.personalCount(userId, groupId),
        this.channelAccess.hasUnread(userId, groupId),
      ]);
      return { channelsAvailable: true, channelPersonalCount, channelHasUnread };
    } catch (error) {
      if (error instanceof NotFoundException) return { channelsAvailable: false, channelPersonalCount: 0, channelHasUnread: false };
      throw error;
    }
  }

  private async ensureUniqueSlug(base: string): Promise<string> {
    let slug = base || 'group';
    let n = 0;
    while (true) {
      const candidate = n === 0 ? slug : `${slug}-${n}`;
      if (candidate.length > 80) {
        slug = slug.slice(0, 60);
        n = 0;
        continue;
      }
      const exists = await this.prisma.communityGroup.findFirst({
        where: { slug: candidate, deletedAt: null },
        select: { id: true },
      });
      if (!exists) return candidate;
      n += 1;
    }
  }

  async assertActiveMember(groupId: string, userId: string): Promise<void> {
    await getGroupMemberOrThrow(this.prisma, groupId, userId);
  }

  async getNotificationPreferences(viewerUserId: string, groupId: string): Promise<GroupNotificationPreferencesDto> {
    const member = await this.prisma.communityGroupMember.findFirst({
      where: { groupId, userId: viewerUserId, status: 'active', group: { deletedAt: null } },
      select: { notificationPreference: true },
    });
    if (!member) throw new ForbiddenException('You must be a member of this group.');
    return { groupId, preference: member.notificationPreference };
  }

  async setNotificationPreferences(viewerUserId: string, groupId: string, preference: GroupNotificationPreferencesDto['preference']): Promise<GroupNotificationPreferencesDto> {
    // Conditional update prevents a concurrent leave/removal from writing member settings.
    const result = await this.prisma.communityGroupMember.updateMany({
      where: { groupId, userId: viewerUserId, status: 'active', group: { deletedAt: null } },
      data: { notificationPreference: preference },
    });
    if (!result.count) throw new ForbiddenException('You must be a member of this group.');
    const data = { groupId, preference };
    this.presenceRealtime.emitGroupNotificationPreferencesChanged(viewerUserId, data);
    return data;
  }

  async getActivity(viewerUserId: string, groupId: string): Promise<GroupActivityDto> {
    await this.getNotificationPreferences(viewerUserId, groupId);
    const through = new Date();
    const where: Prisma.NotificationWhereInput = {
      recipientUserId: viewerUserId, subjectGroupId: groupId,
      kind: 'community_group_post', deliveredAt: null,
      createdAt: { lte: through },
      subjectPost: { deletedAt: null, isDraft: false },
    };
    const [newPostCount, rows] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({ where, select: { subjectPostId: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 }),
    ]);
    return { groupId, through: through.toISOString(), newPostCount,
      newPostIds: rows.flatMap(row => row.subjectPostId ? [row.subjectPostId] : []) };
  }

  async getShellBySlug(params: { slug: string; viewerUserId: string | null }) {
    const slug = (params.slug ?? '').trim();
    if (!slug) throw new NotFoundException('Group not found.');
    const g = await this.prisma.communityGroup.findFirst({
      where: { slug, deletedAt: null },
    });
    if (!g) throw new NotFoundException('Group not found.');

    let viewerMembership: { status: string; role: string } | null = null;
    if (params.viewerUserId) {
      const row = await this.prisma.communityGroupMember.findUnique({
        where: { groupId_userId: { groupId: g.id, userId: params.viewerUserId } },
        select: { status: true, role: true },
      });
      viewerMembership = row ? { status: row.status, role: row.role } : null;
    }

    const dto = toCommunityGroupShellDto(g, viewerMembership as Parameters<typeof toCommunityGroupShellDto>[1]);
    Object.assign(dto, await this.channelSummary(params.viewerUserId, g.id));
    // Don't expose rules to anonymous viewers
    if (!params.viewerUserId) dto.rules = null;

    // Owners + mods get badge counts: pending join requests (approval-policy
    // groups) and pending outbound invites. Both feed badges in the header so
    // owners can land on the right management page without hunting.
    const isAdmin = viewerMembership?.status === 'active' &&
      (viewerMembership.role === 'owner' || viewerMembership.role === 'moderator');
    if (isAdmin) {
      if (g.joinPolicy === 'approval') {
        dto.pendingMemberCount = await this.prisma.communityGroupMember.count({
          where: { groupId: g.id, status: 'pending' },
        });
      }
      dto.pendingInviteCount = await this.prisma.communityGroupInvite.count({
        where: { groupId: g.id, status: 'pending', expiresAt: { gt: new Date() } },
      });
    }

    // Expose Marv's membership status so owner/mod UIs can render Add/Remove Marv CTAs.
    const marvCfg = this.appConfig.marvBot();
    if (marvCfg.enabled) {
      const marvId = this.marvIdentity.cachedMarvUserId() ?? await this.marvIdentity.getMarvUserId();
      if (marvId) {
        const marvUser = await this.prisma.user.findUnique({
          where: { id: marvId },
          select: { username: true },
        });
        const marvMembership = await this.prisma.communityGroupMember.findUnique({
          where: { groupId_userId: { groupId: g.id, userId: marvId } },
          select: { status: true },
        });
        dto.marv = {
          userId: marvId,
          username: marvUser?.username ?? null,
          isMember: marvMembership?.status === 'active',
        };
      }
    }

    return { data: dto };
  }

  async listFeatured(params: { viewerUserId: string | null }) {
    const cacheKey = RedisKeys.groupsFeatured(params.viewerUserId ?? 'anon');
    try {
      const cached = await this.redis.getJson<{ data: unknown[] }>(cacheKey);
      if (cached) return cached;
    } catch { /* Redis unavailable */ }

    const rows = await this.prisma.communityGroup.findMany({
      where: { deletedAt: null, isFeatured: true },
      orderBy: [{ featuredOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const groupIds = rows.map((r) => r.id);
    const memberships = params.viewerUserId
      ? await this.prisma.communityGroupMember.findMany({
          where: { userId: params.viewerUserId, groupId: { in: groupIds } },
          select: { groupId: true, status: true, role: true },
        })
      : [];
    const byGroup = new Map(memberships.map((m) => [m.groupId, m] as const));
    const result = {
      data: rows.map((g) => {
        const m = byGroup.get(g.id);
        const viewerMembership = m ? { status: m.status, role: m.role } : null;
        return toCommunityGroupShellDto(g, viewerMembership);
      }),
    };

    void this.redis.setJson(cacheKey, result, { ttlSeconds: FEATURED_CACHE_TTL_SECONDS }).catch(() => undefined);
    return result;
  }

  async listMine(params: { viewerUserId: string }) {
    const memberships = await this.prisma.communityGroupMember.findMany({
      where: { userId: params.viewerUserId, status: 'active' },
      include: { group: true },
      orderBy: [{ role: 'asc' }, { createdAt: 'desc' }],
    });

    const active = memberships.filter((m) => m.group.deletedAt == null);
    const groupIds = active.map((m) => m.groupId);

    const lastPostRows =
      groupIds.length > 0
        ? await this.postsRead.read.groupBy({
            by: ['communityGroupId'],
            where: {
              userId: params.viewerUserId,
              communityGroupId: { in: groupIds },
              deletedAt: null,
              isDraft: false,
            },
            _max: { createdAt: true },
          })
        : [];

    const lastPostByGroupId = new Map(
      lastPostRows.map((r) => [r.communityGroupId!, r._max.createdAt]),
    );

    const data = active
      .sort((a, b) =>
        this.compareViewerGroupOrder(
          { createdAt: a.group.createdAt },
          { status: a.status, role: a.role, createdAt: a.createdAt },
          { createdAt: b.group.createdAt },
          { status: b.status, role: b.role, createdAt: b.createdAt },
        ),
      )
      .map((m) => ({
        ...toCommunityGroupShellDto(m.group, { status: m.status, role: m.role }),
        lastViewerPostAt: lastPostByGroupId.get(m.groupId)?.toISOString() ?? null,
      }));

    return { data: await Promise.all(data.map(async group => ({ ...group, ...await this.channelSummary(params.viewerUserId, group.id) }))) };
  }

  async create(params: {
    viewerUserId: string;
    isPremium: boolean;
    isSiteAdmin: boolean;
    name: string;
    description: string;
    rules?: string | null;
    coverImageUrl?: string | null;
    avatarImageUrl?: string | null;
    joinPolicy: CommunityGroupJoinPolicy;
  }) {
    if (!params.isPremium && !params.isSiteAdmin) {
      throw new ForbiddenException('Only premium members can create groups.');
    }
    const name = params.name.trim();
    const description = params.description.trim();
    if (!name) throw new BadRequestException('Name is required.');
    if (!description) throw new BadRequestException('Description is required.');
    if (name.length > 120) throw new BadRequestException('Name is too long.');
    const slug = await this.ensureUniqueSlug(slugifyHandle(name));

    const g = await this.prisma.$transaction(async (tx) => {
      const created = await tx.communityGroup.create({
        data: {
          slug,
          name,
          description,
          rules: params.rules?.trim() || null,
          coverImageUrl: params.coverImageUrl?.trim() || null,
          avatarImageUrl: params.avatarImageUrl?.trim() || null,
          joinPolicy: params.joinPolicy,
          createdByUserId: params.viewerUserId,
          memberCount: 1,
        },
      });
      await tx.communityGroupMember.create({
        data: {
          groupId: created.id,
          userId: params.viewerUserId,
          role: 'owner',
          status: 'active',
        },
      });
      await provisionDefaultChannels(tx, created.id, params.viewerUserId);
      return created;
    });

    return {
      data: toCommunityGroupShellDto(g, { status: 'active', role: 'owner' }),
    };
  }

  async updateGroup(params: {
    viewerUserId: string;
    isSiteAdmin: boolean;
    groupId: string;
    name?: string;
    description?: string;
    rules?: string | null;
    coverImageUrl?: string | null;
    avatarImageUrl?: string | null;
    joinPolicy?: CommunityGroupJoinPolicy;
    isFeatured?: boolean;
    featuredOrder?: number;
  }) {
    const g = await this.prisma.communityGroup.findFirst({
      where: { id: params.groupId, deletedAt: null },
    });
    if (!g) throw new NotFoundException('Group not found.');

    const mem = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: g.id, userId: params.viewerUserId } },
      select: { role: true, status: true },
    });
    const isOwner = mem?.status === 'active' && mem.role === 'owner';
    if (!isOwner && !params.isSiteAdmin) throw new ForbiddenException('Not allowed to update this group.');

    const data: Record<string, unknown> = {};
    if (params.name !== undefined) {
      const name = params.name.trim();
      if (!name) throw new BadRequestException('Name is required.');
      data.name = name;
    }
    if (params.description !== undefined) {
      const d = params.description.trim();
      if (!d) throw new BadRequestException('Description is required.');
      data.description = d;
    }
    if (params.rules !== undefined) data.rules = params.rules?.trim() || null;
    if (params.coverImageUrl !== undefined) data.coverImageUrl = params.coverImageUrl?.trim() || null;
    if (params.avatarImageUrl !== undefined) data.avatarImageUrl = params.avatarImageUrl?.trim() || null;
    if (params.joinPolicy !== undefined) {
      if (!isOwner && !params.isSiteAdmin) throw new ForbiddenException('Only the owner can change join policy.');
      // Privacy is one-way: open -> private is allowed (with UI warning), but
      // private -> open is permanently blocked. Members joined under a privacy
      // promise; lifting it would silently expose their participation.
      if (g.joinPolicy === 'approval' && params.joinPolicy === 'open') {
        throw new BadRequestException('A private group cannot be made open. This is permanent.');
      }
      data.joinPolicy = params.joinPolicy;
    }
    if (params.isFeatured !== undefined || params.featuredOrder !== undefined) {
      if (!params.isSiteAdmin) throw new ForbiddenException('Only admins can change featured settings.');
      if (params.isFeatured !== undefined) data.isFeatured = params.isFeatured;
      if (params.featuredOrder !== undefined) data.featuredOrder = params.featuredOrder;
    }

    if (Object.keys(data).length === 0) {
      const vm0 = await this.prisma.communityGroupMember.findUnique({
        where: { groupId_userId: { groupId: g.id, userId: params.viewerUserId } },
        select: { status: true, role: true },
      });
      return { data: toCommunityGroupShellDto(g, vm0 ? { status: vm0.status, role: vm0.role } : null) };
    }

    const updated = await this.prisma.communityGroup.update({
      where: { id: g.id },
      data: data as any,
    });
    const vm = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: updated.id, userId: params.viewerUserId } },
      select: { status: true, role: true },
    });
    return {
      data: toCommunityGroupShellDto(
        updated,
        vm ? { status: vm.status, role: vm.role } : null,
      ),
    };
  }

  /**
   * Soft-deletes a group. Only the owner (or a site admin) may do it, and the caller must retype
   * the exact group name. Channel access, shells, invites and discovery all key off `deletedAt`,
   * so the group disappears everywhere at once; the slug stays reserved.
   */
  async deleteGroup(params: {
    viewerUserId: string;
    isSiteAdmin: boolean;
    groupId: string;
    confirmName: string;
  }): Promise<{ deleted: true }> {
    const g = await this.prisma.communityGroup.findFirst({
      where: { id: params.groupId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!g) throw new NotFoundException('Group not found.');
    const mem = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: g.id, userId: params.viewerUserId } },
      select: { role: true, status: true },
    });
    const isOwner = mem?.status === 'active' && mem.role === 'owner';
    if (!isOwner && !params.isSiteAdmin) throw new ForbiddenException('Only the owner can delete this group.');
    if (params.confirmName.trim() !== g.name.trim()) {
      throw new BadRequestException('Type the exact group name to confirm.');
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.communityGroup.update({
        where: { id: g.id },
        data: { deletedAt: now, isFeatured: false },
      }),
      this.prisma.communityGroupInvite.updateMany({
        where: { groupId: g.id, status: 'pending' },
        data: { status: 'cancelled', respondedAt: now },
      }),
    ]);
    void this.redis.del(...['anon', params.viewerUserId].map((id) => RedisKeys.groupsFeatured(id))).catch(() => undefined);
    return { deleted: true };
  }

  async join(params: { viewerUserId: string; groupId: string }) {
    const viewer = await this.prisma.user.findUnique({
      where: { id: params.viewerUserId },
      select: { verifiedStatus: true },
    });
    if (!viewer) throw new NotFoundException('User not found.');
    if (!viewer.verifiedStatus || viewer.verifiedStatus === 'none') {
      throw new ForbiddenException('Verify your account to join groups.');
    }

    const g = await this.prisma.communityGroup.findFirst({
      where: { id: params.groupId, deletedAt: null },
    });
    if (!g) throw new NotFoundException('Group not found.');

    const existing = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: g.id, userId: params.viewerUserId } },
    });
    if (existing?.status === 'active') {
      return { data: { ok: true as const, status: 'active' as const } };
    }
    if (existing?.status === 'pending') {
      return { data: { ok: true as const, status: 'pending' as const } };
    }

    if (g.joinPolicy === 'open') {
      await this.prisma.$transaction(async (tx) => {
        // Re-check membership inside the transaction so concurrent joins are idempotent.
        const current = await tx.communityGroupMember.findUnique({
          where: { groupId_userId: { groupId: g.id, userId: params.viewerUserId } },
          select: { status: true },
        });
        if (current?.status === 'active') return;
        if (current?.status === 'pending') {
          await tx.communityGroupMember.update({
            where: { groupId_userId: { groupId: g.id, userId: params.viewerUserId } },
            data: { status: 'active', role: 'member' },
          });
          await tx.communityGroup.update({
            where: { id: g.id },
            data: { memberCount: { increment: 1 } },
          });
          return;
        }

        try {
          await tx.communityGroupMember.create({
            data: {
              groupId: g.id,
              userId: params.viewerUserId,
              role: 'member',
              status: 'active',
            },
          });
          await tx.communityGroup.update({
            where: { id: g.id },
            data: { memberCount: { increment: 1 } },
          });
        } catch (e: unknown) {
          // Concurrent create hit unique constraint: treat as successful idempotent join.
          if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
        }
      });

      this.sideEffects.dispatch('group.member.joined', {
        groupId: g.id,
        joinerUserId: params.viewerUserId,
      });
      this.sideEffects.dispatch('channel.member.joined', {
        groupId: g.id,
        userId: params.viewerUserId,
        at: new Date().toISOString(),
      });

      return { data: { ok: true as const, status: 'active' as const } };
    }

    const isNewRequest = !existing || existing.status !== 'pending';
    await this.prisma.communityGroupMember.upsert({
      where: { groupId_userId: { groupId: g.id, userId: params.viewerUserId } },
      create: {
        groupId: g.id,
        userId: params.viewerUserId,
        role: 'member',
        status: 'pending',
      },
      update: { status: 'pending', role: 'member' },
    });

    if (isNewRequest) {
      this.sideEffects.dispatch('group.join.requested', {
        groupId: g.id,
        requestingUserId: params.viewerUserId,
      });
    }

    return { data: { ok: true as const, status: 'pending' as const } };
  }

  async leave(params: { viewerUserId: string; groupId: string }) {
    await this.prisma.$transaction(async tx => {
      await prepareChannelDeparture(tx, params.groupId, params.viewerUserId, { forced: false });
      const mem = await tx.communityGroupMember.findUnique({ where: { groupId_userId: { groupId: params.groupId, userId: params.viewerUserId } } });
      if (!mem) return;
      if (mem.role === 'owner') throw new BadRequestException('Transfer ownership before leaving, or delete the group.');
      await tx.communityGroupMember.delete({ where: { groupId_userId: { groupId: params.groupId, userId: params.viewerUserId } } });
      if (mem.status === 'active') await tx.communityGroup.update({ where: { id: params.groupId }, data: { memberCount: { decrement: 1 } } });
    });
    await emitChannelAccessChange(this.prisma, this.presenceRealtime, params.groupId, params.viewerUserId);
    return { data: { ok: true as const } };
  }

  async cancelRequest(params: { viewerUserId: string; groupId: string }) {
    const g = await this.prisma.communityGroup.findFirst({
      where: { id: params.groupId, deletedAt: null },
    });
    if (!g) throw new NotFoundException('Group not found.');

    const mem = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: g.id, userId: params.viewerUserId } },
    });
    if (mem?.status === 'pending') {
      await this.prisma.communityGroupMember.delete({
        where: { groupId_userId: { groupId: g.id, userId: params.viewerUserId } },
      });
    }
    return { data: { ok: true as const } };
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
      where: { id: params.groupId, deletedAt: null },
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
      where: { id: params.groupId, deletedAt: null },
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
      where: { id: params.groupId, deletedAt: null },
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

  async groupFeed(params: {
    viewerUserId: string;
    slug: string;
    limit: number;
    cursor: string | null;
    sort: 'new' | 'trending';
    topLevelOnly?: boolean;
  }) {
    const slug = (params.slug ?? '').trim();
    if (!slug) throw new NotFoundException('Group not found.');
    const g = await this.prisma.communityGroup.findFirst({
      where: { slug, deletedAt: null },
    });
    if (!g) throw new NotFoundException('Group not found.');

    // Read access: open groups are visible to any verified user; private groups
    // remain members-only. Composer membership is enforced separately on write.
    await this.posts.assertCanReadCommunityGroup(params.viewerUserId, g.id);

    const collapseOpts = {
      collapseByRoot: true,
      collapseMode: 'root' as const,
      prefer: 'reply' as const,
      collapseMaxPerRoot: 2,
    };
    return this.posts.listComposedGroupScopedFeed({
      viewerUserId: params.viewerUserId,
      groupIds: [g.id],
      limit: params.limit,
      cursor: params.cursor,
      sort: params.sort,
      applyPinnedHead: params.sort === 'new',
      topLevelOnly: params.topLevelOnly,
      ...collapseOpts,
    });
  }

  async groupMedia(params: {
    viewerUserId: string;
    slug: string;
    limit: number;
    cursor: string | null;
    sort: 'new' | 'trending';
  }) {
    const slug = (params.slug ?? '').trim();
    if (!slug) throw new NotFoundException('Group not found.');
    const g = await this.prisma.communityGroup.findFirst({
      where: { slug, deletedAt: null },
    });
    if (!g) throw new NotFoundException('Group not found.');

    const result = await this.posts.listMediaForCommunityGroup({
      viewerUserId: params.viewerUserId,
      groupId: g.id,
      limit: params.limit,
      cursor: params.cursor,
      sort: params.sort,
    });
    return { data: result.items, pagination: { nextCursor: result.nextCursor } };
  }

  async groupsHubMedia(params: {
    viewerUserId: string;
    limit: number;
    cursor: string | null;
    sort: 'new' | 'trending';
  }) {
    const result = await this.posts.listMediaForGroupsHub({
      viewerUserId: params.viewerUserId,
      limit: params.limit,
      cursor: params.cursor,
      sort: params.sort,
    });
    return { data: result.items, pagination: { nextCursor: result.nextCursor } };
  }

  async myGroupsHubFeed(params: {
    viewerUserId: string;
    groupId: string | null;
    limit: number;
    cursor: string | null;
    sort: 'new' | 'trending';
  }) {
    const filterId = (params.groupId ?? '').trim() || null;
    const collapseOpts = {
      collapseByRoot: true,
      collapseMode: 'root' as const,
      prefer: 'reply' as const,
      collapseMaxPerRoot: 2,
    };

    if (filterId) {
      await this.assertActiveMember(filterId, params.viewerUserId);
      return this.posts.listComposedGroupScopedFeed({
        viewerUserId: params.viewerUserId,
        groupIds: [filterId],
        limit: params.limit,
        cursor: params.cursor,
        sort: params.sort,
        applyPinnedHead: params.sort === 'new',
        ...collapseOpts,
      });
    }

    const memberships = await this.prisma.communityGroupMember.findMany({
      where: { userId: params.viewerUserId, status: 'active' },
      select: { groupId: true },
    });
    const groupIds = memberships.map((m) => m.groupId);
    if (groupIds.length === 0) {
      return { data: [], pagination: { nextCursor: null as string | null } };
    }

    return this.posts.listComposedGroupScopedFeed({
      viewerUserId: params.viewerUserId,
      groupIds,
      limit: params.limit,
      cursor: params.cursor,
      sort: params.sort,
      applyPinnedHead: false,
      ...collapseOpts,
    });
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

  async pinPost(params: { viewerUserId: string; isSiteAdmin: boolean; groupId: string; postId: string }) {
    const mem = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: params.groupId, userId: params.viewerUserId } },
      select: { status: true, role: true },
    });
    const isOwner = mem?.status === 'active' && mem.role === 'owner';
    if (!isOwner && !params.isSiteAdmin) {
      throw new ForbiddenException('Only the group owner can pin posts.');
    }
    const postId = (params.postId ?? '').trim();
    if (!postId) throw new NotFoundException('Post not found.');
    const post = await this.postsRead.read.findFirst({
      where: {
        id: postId,
        communityGroupId: params.groupId,
        parentId: null,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Post not found.');

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.postsWrite.writeOn(tx).updateMany({
        where: { communityGroupId: params.groupId, pinnedInGroupAt: { not: null } },
        data: { pinnedInGroupAt: null },
      });
      await this.postsWrite.writeOn(tx).update({
        where: { id: postId },
        data: { pinnedInGroupAt: now },
      });
    });
    return { data: { ok: true as const } };
  }

  async unpinGroupPost(params: { viewerUserId: string; isSiteAdmin: boolean; groupId: string }) {
    const mem = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: params.groupId, userId: params.viewerUserId } },
      select: { status: true, role: true },
    });
    const isOwner = mem?.status === 'active' && mem.role === 'owner';
    if (!isOwner && !params.isSiteAdmin) {
      throw new ForbiddenException('Only the group owner can unpin posts.');
    }
    await this.postsWrite.write.updateMany({
      where: { communityGroupId: params.groupId, pinnedInGroupAt: { not: null } },
      data: { pinnedInGroupAt: null },
    });
    return { data: { ok: true as const } };
  }

  async resolveGroupIdBySlug(slug: string): Promise<string | null> {
    const s = (slug ?? '').trim();
    if (!s) return null;
    const g = await this.prisma.communityGroup.findFirst({
      where: { slug: s, deletedAt: null },
      select: { id: true },
    });
    return g?.id ?? null;
  }

  async searchGroups(params: {
    viewerUserId: string | null;
    q: string;
    limit: number;
    cursor: string | null;
    excludeMine?: boolean;
  }): Promise<{
    data: ReturnType<typeof toCommunityGroupShellDto>[];
    pagination: { nextCursor: string | null };
  }> {
    return searchGroupsOn(this, params);
  }


  async listExploreSpotlight(
    viewerUserId: string | null,
    opts: { excludeMine?: boolean; take?: number; cursor?: string | null } = {},
  ) {
    return listExploreSpotlightOn(this, viewerUserId, opts);
  }

  compareViewerGroupOrder(
    aGroup: { createdAt?: Date },
    aMembership: { status: string; role: string; createdAt: Date } | null | undefined,
    bGroup: { createdAt?: Date },
    bMembership: { status: string; role: string; createdAt: Date } | null | undefined,
  ): number {
    const aOwner = aMembership?.status === 'active' && aMembership.role === 'owner';
    const bOwner = bMembership?.status === 'active' && bMembership.role === 'owner';
    if (aOwner !== bOwner) return aOwner ? -1 : 1;

    const aJoined = aMembership?.status === 'active';
    const bJoined = bMembership?.status === 'active';
    if (aJoined !== bJoined) return aJoined ? -1 : 1;

    const aDate = (aMembership?.createdAt ?? aGroup.createdAt)?.getTime() ?? 0;
    const bDate = (bMembership?.createdAt ?? bGroup.createdAt)?.getTime() ?? 0;
    return bDate - aDate;
  }
}
