
import { isUniqueViolation } from '../../common/prisma/errors';
import { getGroupMemberOrThrow } from '../viewer/group-membership.queries';
import { ChannelAccessService } from '../group-channels/channel-access.service';
import { prepareChannelDeparture, emitChannelAccessChange } from '../group-channels/channel-lifecycle';
import { provisionDefaultChannels } from '../group-channels/channel-provisioning';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { CommunityGroupJoinPolicy } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toCommunityGroupShellDto, type GroupNotificationPreferencesDto, type GroupActivityDto } from '../../common/dto/community-group.dto';

import { AppConfigService } from '../app/app-config.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { MarvinBotIdentityService } from '../marvin/services/marvin-bot-identity.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';

import { PostsReadService } from '../posts-read/posts-read.service';
import { PostsWriteService } from '../posts-read/posts-write.service';
import { GroupsSearchService } from './groups-search.service';
import { GroupsExploreService, compareViewerGroupOrder } from './groups-explore.service';
import { slugifyHandle } from '../../common/text/slugify';
import { NOT_DELETED } from '../../common/prisma/where';
const FEATURED_CACHE_TTL_SECONDS = 120;

@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRead: PostsReadService,
    private readonly postsWrite: PostsWriteService,

    private readonly appConfig: AppConfigService,
    private readonly sideEffects: SideEffectsService,
    private readonly redis: RedisService,
    private readonly marvIdentity: MarvinBotIdentityService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly search: GroupsSearchService,
    private readonly explore: GroupsExploreService,
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
        where: { slug: candidate, ...NOT_DELETED },
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
      where: { groupId, userId: viewerUserId, status: 'active', group: NOT_DELETED },
      select: { notificationPreference: true },
    });
    if (!member) throw new ForbiddenException('You must be a member of this group.');
    return { groupId, preference: member.notificationPreference };
  }

  async setNotificationPreferences(viewerUserId: string, groupId: string, preference: GroupNotificationPreferencesDto['preference']): Promise<GroupNotificationPreferencesDto> {
    // Conditional update prevents a concurrent leave/removal from writing member settings.
    const result = await this.prisma.communityGroupMember.updateMany({
      where: { groupId, userId: viewerUserId, status: 'active', group: NOT_DELETED },
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
      subjectPost: { ...NOT_DELETED, isDraft: false },
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
      where: { slug, ...NOT_DELETED },
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
      where: { ...NOT_DELETED, isFeatured: true },
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
        ? await this.postsRead.lastActivityByGroup({
              userId: params.viewerUserId,
              communityGroupId: { in: groupIds },
              ...NOT_DELETED,
              isDraft: false,
            })
        : [];

    const lastPostByGroupId = new Map(
      lastPostRows.map((r) => [r.communityGroupId!, r._max.createdAt]),
    );

    const data = active
      .sort((a, b) =>
        compareViewerGroupOrder(
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
      where: { id: params.groupId, ...NOT_DELETED },
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
      data,
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
      where: { id: params.groupId, ...NOT_DELETED },
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
      where: { id: params.groupId, ...NOT_DELETED },
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
          if (!isUniqueViolation(e)) throw e;
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
      where: { id: params.groupId, ...NOT_DELETED },
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
    const post = await this.postsRead.findFirst({
      where: {
        id: postId,
        communityGroupId: params.groupId,
        parentId: null,
        ...NOT_DELETED,
      },
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Post not found.');

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.postsWrite.replaceGroupPin(tx, params.groupId, postId, now);
      ;
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
    await this.postsWrite.clearGroupPin(params.groupId);
    return { data: { ok: true as const } };
  }

  async resolveGroupIdBySlug(slug: string): Promise<string | null> {
    const s = (slug ?? '').trim();
    if (!s) return null;
    const g = await this.prisma.communityGroup.findFirst({
      where: { slug: s, ...NOT_DELETED },
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
    return this.search.searchGroups(params);
  }


  async listExploreSpotlight(
    viewerUserId: string | null,
    opts: { excludeMine?: boolean; take?: number; cursor?: string | null } = {},
  ) {
    return this.explore.listExploreSpotlight(viewerUserId, opts);
  }
}
