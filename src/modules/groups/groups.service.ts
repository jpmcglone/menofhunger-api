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
} from '../../common/dto/community-group.dto';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { PostsService } from '../posts/posts.service';
import { AppConfigService } from '../app/app-config.service';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';

const FEATURED_CACHE_TTL_SECONDS = 120;

function slugifyBase(name: string): string {
  return (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
}

@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
    private readonly appConfig: AppConfigService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
  ) {}

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
    const m = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: { status: true },
    });
    if (!m || m.status !== 'active') {
      throw new ForbiddenException('You must be a member of this group.');
    }
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

    return { data: dto };
  }

  async listFeatured(params: { viewerUserId: string }) {
    const cacheKey = RedisKeys.groupsFeatured(params.viewerUserId);
    try {
      const cached = await this.redis.getJson<{ data: unknown[] }>(cacheKey);
      if (cached) return cached;
    } catch { /* Redis unavailable */ }

    const rows = await this.prisma.communityGroup.findMany({
      where: { deletedAt: null, isFeatured: true },
      orderBy: [{ featuredOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const groupIds = rows.map((r) => r.id);
    const memberships = await this.prisma.communityGroupMember.findMany({
      where: { userId: params.viewerUserId, groupId: { in: groupIds } },
      select: { groupId: true, status: true, role: true },
    });
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
      orderBy: { createdAt: 'desc' },
    });
    const data = memberships
      .filter((m) => m.group.deletedAt == null)
      .map((m) =>
        toCommunityGroupShellDto(m.group, { status: m.status, role: m.role }),
      );
    return { data };
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
    const slug = await this.ensureUniqueSlug(slugifyBase(name));

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

  async join(params: { viewerUserId: string; groupId: string }) {
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

    // Notify owners and moderators of the new join request (best-effort).
    if (isNewRequest) {
      void this.notifyGroupAdminsOfJoinRequest({
        groupId: g.id,
        requestingUserId: params.viewerUserId,
      }).catch(() => undefined);
    }

    return { data: { ok: true as const, status: 'pending' as const } };
  }

  private async notifyGroupAdminsOfJoinRequest(params: {
    groupId: string;
    requestingUserId: string;
  }): Promise<void> {
    const { groupId, requestingUserId } = params;
    const admins = await this.prisma.communityGroupMember.findMany({
      where: { groupId, status: 'active', role: { in: ['owner', 'moderator'] } },
      select: { userId: true },
    });
    for (const admin of admins) {
      if (admin.userId === requestingUserId) continue;
      await this.notifications.create({
        recipientUserId: admin.userId,
        kind: 'group_join_request',
        actorUserId: requestingUserId,
        subjectGroupId: groupId,
      });
    }
  }

  async leave(params: { viewerUserId: string; groupId: string }) {
    const g = await this.prisma.communityGroup.findFirst({
      where: { id: params.groupId, deletedAt: null },
    });
    if (!g) throw new NotFoundException('Group not found.');

    const mem = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: g.id, userId: params.viewerUserId } },
    });
    if (!mem) return { data: { ok: true as const } };
    if (mem.role === 'owner') {
      throw new BadRequestException('Transfer ownership before leaving, or delete the group.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.communityGroupMember.delete({
        where: { groupId_userId: { groupId: g.id, userId: params.viewerUserId } },
      });
      if (mem.status === 'active') {
        await tx.communityGroup.update({
          where: { id: g.id },
          data: { memberCount: { decrement: 1 } },
        });
      }
    });
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
    const mem = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: { role: true, status: true },
    });
    if (!mem || mem.status !== 'active') throw new ForbiddenException('Not allowed.');
    if (mem.role !== 'owner' && mem.role !== 'moderator') throw new ForbiddenException('Not allowed.');
    return mem.role;
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
      await tx.communityGroupMember.delete({
        where: { groupId_userId: { groupId: params.groupId, userId: params.userId } },
      });
      await tx.communityGroup.update({
        where: { id: params.groupId },
        data: { memberCount: { decrement: 1 } },
      });
    });
    return { data: { ok: true as const } };
  }

  async promoteModerator(params: { viewerUserId: string; groupId: string; userId: string }) {
    const group = await this.prisma.communityGroup.findFirst({
      where: { id: params.groupId, deletedAt: null },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Group not found.');

    const mem = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: params.viewerUserId } },
      select: { role: true, status: true },
    });
    if (!mem || mem.status !== 'active' || mem.role !== 'owner') {
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

  async demoteModerator(params: { viewerUserId: string; groupId: string; userId: string }) {
    const group = await this.prisma.communityGroup.findFirst({
      where: { id: params.groupId, deletedAt: null },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Group not found.');

    const mem = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: params.viewerUserId } },
      select: { role: true, status: true },
    });
    if (!mem || mem.status !== 'active' || mem.role !== 'owner') {
      throw new ForbiddenException('Only the owner can demote moderators.');
    }

    const target = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: params.userId } },
    });
    if (!target || target.status !== 'active' || target.role !== 'moderator') {
      throw new NotFoundException('Moderator not found.');
    }

    await this.prisma.communityGroupMember.update({
      where: { groupId_userId: { groupId: group.id, userId: params.userId } },
      data: { role: 'member' },
    });
    return { data: { ok: true as const } };
  }

  async groupFeed(params: {
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
      ...collapseOpts,
    });
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
    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? slice[slice.length - 1]?.userId ?? null : null;

    const data: CommunityGroupMemberListItemDto[] = slice.map((m) => ({
      userId: m.userId,
      username: m.user.username,
      name: m.user.name,
      role: m.role,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: r2,
        key: m.user.avatarKey ?? null,
        updatedAt: m.user.avatarUpdatedAt ?? null,
      }),
      joinedAt: m.createdAt.toISOString(),
    }));

    return { data, pagination: { nextCursor } };
  }

  async pinPost(params: { viewerUserId: string; groupId: string; postId: string }) {
    const mem = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: params.groupId, userId: params.viewerUserId } },
      select: { status: true, role: true },
    });
    if (!mem || mem.status !== 'active' || mem.role !== 'owner') {
      throw new ForbiddenException('Only the group owner can pin posts.');
    }
    const postId = (params.postId ?? '').trim();
    if (!postId) throw new NotFoundException('Post not found.');
    const post = await this.prisma.post.findFirst({
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
      await tx.post.updateMany({
        where: { communityGroupId: params.groupId, pinnedInGroupAt: { not: null } },
        data: { pinnedInGroupAt: null },
      });
      await tx.post.update({
        where: { id: postId },
        data: { pinnedInGroupAt: now },
      });
    });
    return { data: { ok: true as const } };
  }

  async unpinGroupPost(params: { viewerUserId: string; groupId: string }) {
    const mem = await this.prisma.communityGroupMember.findUnique({
      where: { groupId_userId: { groupId: params.groupId, userId: params.viewerUserId } },
      select: { status: true, role: true },
    });
    if (!mem || mem.status !== 'active' || mem.role !== 'owner') {
      throw new ForbiddenException('Only the group owner can unpin posts.');
    }
    await this.prisma.post.updateMany({
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

  /** Featured groups first, then top communities by member count (Explore discovery). */
  async listExploreSpotlight(viewerUserId: string | null) {
    const featured = await this.prisma.communityGroup.findMany({
      where: { deletedAt: null, isFeatured: true },
      orderBy: [{ featuredOrder: 'asc' }, { createdAt: 'asc' }],
      take: 8,
    });
    const featuredIds = featured.map((g) => g.id);
    const takeMore = Math.max(0, 12 - featured.length);
    const more =
      takeMore > 0
        ? await this.prisma.communityGroup.findMany({
            where: {
              deletedAt: null,
              ...(featuredIds.length ? { id: { notIn: featuredIds } } : {}),
            },
            orderBy: [{ memberCount: 'desc' }, { createdAt: 'desc' }],
            take: takeMore,
          })
        : [];
    const rows = [...featured, ...more];
    if (!viewerUserId) {
      return { data: rows.map((g) => toCommunityGroupShellDto(g, null)) };
    }
    const memberships = await this.prisma.communityGroupMember.findMany({
      where: { userId: viewerUserId, groupId: { in: rows.map((r) => r.id) } },
      select: { groupId: true, status: true, role: true },
    });
    const byGroup = new Map(memberships.map((m) => [m.groupId, m] as const));
    return {
      data: rows.map((g) => {
        const m = byGroup.get(g.id);
        const viewerMembership = m ? { status: m.status, role: m.role } : null;
        return toCommunityGroupShellDto(g, viewerMembership);
      }),
    };
  }
}
