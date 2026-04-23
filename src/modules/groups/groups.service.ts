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

/**
 * Keyset cursor for /groups/search pagination. Encodes the (memberCount, id)
 * tuple of the LAST row in the previous page so the next request can
 * `WHERE memberCount < c OR (memberCount = c AND id < lastId)`.
 */
function encodeGroupCursor(c: { memberCount: number; id: string }): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeGroupCursor(
  raw: string | null | undefined,
): { memberCount: number; id: string } | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { memberCount?: unknown; id?: unknown };
    if (typeof parsed.memberCount !== 'number' || typeof parsed.id !== 'string') return null;
    return { memberCount: parsed.memberCount, id: parsed.id };
  } catch {
    return null;
  }
}

/** Unique, non-empty, lowercased words from a search query. */
function queryToWords(q: string): string[] {
  const trimmed = (q ?? '').trim().toLowerCase();
  if (!trimmed) return [];
  return [...new Set(trimmed.split(/\s+/).filter((w) => w.length > 0))];
}

/**
 * Relevance score for a group against a search query. Higher is better; ties
 * are broken by `memberCount` then `id`. The bands are intentionally chunky so
 * a strong signal in one field always beats a weak signal in many — that's
 * what makes "yoga" surface a group named "Yoga" before one whose rules
 * happen to mention yoga in passing.
 *
 * - 100  exact name or slug match
 * -  90  name starts with the query
 * -  85  slug starts with the query
 * -  80  name contains the query (phrase)
 * -  75  slug contains the query (phrase)
 * -  70  every query word appears in the name
 * -  60  description contains the query (phrase)
 * -  50  every query word appears in the description
 * -  45  any query word appears in the name
 * -  40  any query word appears in the slug
 * -  30  any query word appears in the description
 * -  20  any query word appears in the rules
 * -  10  fuzzy/FTS-only match (typo tolerance) — barely surfaces but isn't lost
 */
function scoreGroupAgainstQuery(
  g: { name?: string | null; slug?: string | null; description?: string | null; rules?: string | null },
  qLower: string,
  words: string[],
): number {
  const name = (g.name ?? '').toLowerCase();
  const slug = (g.slug ?? '').toLowerCase();
  const desc = (g.description ?? '').toLowerCase();
  const rules = (g.rules ?? '').toLowerCase();

  let s = 0;
  if (name === qLower || slug === qLower) s = Math.max(s, 100);
  if (qLower && name.startsWith(qLower)) s = Math.max(s, 90);
  if (qLower && slug.startsWith(qLower)) s = Math.max(s, 85);
  if (qLower && name.includes(qLower)) s = Math.max(s, 80);
  if (qLower && slug.includes(qLower)) s = Math.max(s, 75);
  if (words.length > 0 && words.every((w) => name.includes(w))) s = Math.max(s, 70);
  if (qLower && desc.includes(qLower)) s = Math.max(s, 60);
  if (words.length > 0 && words.every((w) => desc.includes(w))) s = Math.max(s, 50);
  if (words.some((w) => name.includes(w))) s = Math.max(s, 45);
  if (words.some((w) => slug.includes(w))) s = Math.max(s, 40);
  if (words.some((w) => desc.includes(w))) s = Math.max(s, 30);
  if (words.some((w) => rules.includes(w))) s = Math.max(s, 20);
  if (s === 0) s = 10;
  return s;
}

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

  /**
   * Server-side fuzzy group search.
   *
   * The pipeline gathers candidates from up to three sources and unions them:
   *
   *   1. **Substring + per-word ILIKE** on `name`, `slug`, `description`,
   *      `rules`. Catches the common "I typed a few characters of the
   *      thing" case and is the only source guaranteed to run.
   *   2. **Trigram fuzzy** (`pg_trgm`) on `name` and `slug`. Catches typos
   *      ("stocism" → "stoicism") and partial-word matches that ILIKE
   *      would miss. Only runs when the query is ≥3 chars; trigram on
   *      shorter needles is mostly noise.
   *   3. **Full-text search** (`websearch_to_tsquery` over name + slug +
   *      description + rules). Catches multi-word natural-language queries
   *      with stemming ("running clubs" → "run club"). Only runs when the
   *      query has ≥2 words.
   *
   * Candidates are then **scored in memory** so the most relevant match
   * (exact name > prefix > contains > all-words-in-name > description, …)
   * always sits at the top, with `memberCount` as the tiebreaker. The
   * cursor is a numeric offset into the ranked list — same trade-off as
   * `searchPosts`: dead-simple to reason about and fine at the catalog
   * sizes we expect.
   *
   * Private (approval-policy) groups are only returned to viewers who are
   * already active members.
   */
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
    const q = (params.q ?? '').trim();
    if (q.length < 2) return { data: [], pagination: { nextCursor: null } };
    const lim = Math.min(30, Math.max(1, params.limit));
    const needle = q.slice(0, 200);
    const qLower = needle.toLowerCase();
    const words = queryToWords(needle);

    const cursorRaw = (params.cursor ?? '').trim();
    const offset =
      cursorRaw && /^\d+$/.test(cursorRaw) ? Math.max(0, parseInt(cursorRaw, 10)) : 0;

    // Private groups are only visible to active members. We model this as:
    //  joinPolicy = 'open'  OR  viewer is an active member
    const visibilityWhere: Prisma.CommunityGroupWhereInput = params.viewerUserId
      ? {
          OR: [
            { joinPolicy: 'open' },
            {
              members: {
                some: { userId: params.viewerUserId, status: 'active' },
              },
            },
          ],
        }
      : { joinPolicy: 'open' };

    const excludeMineWhere: Prisma.CommunityGroupWhereInput | undefined =
      params.excludeMine && params.viewerUserId
        ? {
            NOT: {
              members: {
                some: { userId: params.viewerUserId, status: 'active' },
              },
            },
          }
        : undefined;

    const baseAnd: Prisma.CommunityGroupWhereInput[] = [
      { deletedAt: null },
      visibilityWhere,
      ...(excludeMineWhere ? [excludeMineWhere] : []),
    ];

    // ─── Source 1: substring + per-word ILIKE ────────────────────────────
    // The OR set is built from a phrase clause for each searchable field
    // plus a per-word clause for every distinct token in the query. This
    // is what makes "running yoga" match a group whose name is "Yoga" and
    // whose description mentions "running buddies".
    const orConditions: Prisma.CommunityGroupWhereInput[] = [
      { name: { contains: needle, mode: 'insensitive' } },
      { slug: { contains: needle, mode: 'insensitive' } },
      { description: { contains: needle, mode: 'insensitive' } },
      { rules: { contains: needle, mode: 'insensitive' } },
    ];
    for (const w of words) {
      if (w === qLower) continue;
      orConditions.push({ name: { contains: w, mode: 'insensitive' } });
      orConditions.push({ slug: { contains: w, mode: 'insensitive' } });
      orConditions.push({ description: { contains: w, mode: 'insensitive' } });
      orConditions.push({ rules: { contains: w, mode: 'insensitive' } });
    }

    // Over-fetch generously so the in-memory ranking has a real candidate
    // pool to choose from. Bounded so a runaway query can't OOM the box.
    const fetchSize = Math.min(150, Math.max(lim * 6, 60));

    const primary = await this.prisma.communityGroup.findMany({
      where: { AND: [...baseAnd, { OR: orConditions }] },
      orderBy: [{ memberCount: 'desc' }, { id: 'desc' }],
      take: fetchSize,
    });

    // ─── Sources 2 + 3: trigram fuzzy + FTS ──────────────────────────────
    // Wrapped in try/catch so environments without `pg_trgm` /
    // `websearch_to_tsquery` (fresh test databases that haven't run the
    // search-index migration, for example) silently degrade to substring
    // results instead of erroring out.
    const useTrigram = needle.length >= 3;
    const useFts = needle.length >= 3 && words.length >= 2;
    let augmentIds: string[] = [];

    if (useTrigram || useFts) {
      const trigramSql = useTrigram
        ? Prisma.sql`(g."name" % ${needle} OR g."slug" % ${needle})`
        : Prisma.sql`FALSE`;
      const ftsSql = useFts
        ? Prisma.sql`to_tsvector(
            'english',
            COALESCE(g."name", '') || ' ' ||
            COALESCE(g."slug", '') || ' ' ||
            COALESCE(g."description", '') || ' ' ||
            COALESCE(g."rules", '')
          ) @@ websearch_to_tsquery('english', ${needle})`
        : Prisma.sql`FALSE`;

      try {
        const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT g."id" AS "id"
          FROM "CommunityGroup" g
          WHERE g."deletedAt" IS NULL
            AND (${trigramSql} OR ${ftsSql})
          LIMIT ${fetchSize}
        `);
        const primaryIds = new Set(primary.map((r) => r.id));
        augmentIds = rows.map((r) => r.id).filter((id) => !primaryIds.has(id));
      } catch {
        augmentIds = [];
      }
    }

    // Hydrate fuzzy/FTS candidates with the same visibility + excludeMine
    // gate as the primary path, so private groups the viewer can't see
    // never leak into the result set even if they matched on text.
    let augment: typeof primary = [];
    if (augmentIds.length > 0) {
      augment = await this.prisma.communityGroup.findMany({
        where: { AND: [...baseAnd, { id: { in: augmentIds } }] },
      });
    }

    const candidates = [...primary, ...augment];

    // ─── Viewer membership (used for owner-first sort + DTO annotation) ──
    // Fetched here, before ranking, so groups the viewer owns can be
    // bumped to the top of the list — even when their text relevance is
    // weaker than another group's. This matters across pagination too:
    // sorting client-side per page would scatter owned groups across pages
    // depending on which slice they happened to land in.
    type ViewerMembershipRow = Prisma.CommunityGroupMemberGetPayload<{
      select: { groupId: true; status: true; role: true };
    }>;
    let allMemberships: ViewerMembershipRow[] = [];
    if (params.viewerUserId && candidates.length > 0) {
      allMemberships = await this.prisma.communityGroupMember.findMany({
        where: { userId: params.viewerUserId, groupId: { in: candidates.map((c) => c.id) } },
        select: { groupId: true, status: true, role: true },
      });
    }
    const ownedIds = new Set(
      allMemberships
        .filter((m) => m.role === 'owner' && m.status === 'active')
        .map((m) => m.groupId),
    );
    const membershipByGroup = new Map(allMemberships.map((m) => [m.groupId, m] as const));

    // ─── Score & rank ────────────────────────────────────────────────────
    const ranked = candidates
      .map((g) => ({ g, score: scoreGroupAgainstQuery(g, qLower, words) }))
      .sort((a, b) => {
        const aOwned = ownedIds.has(a.g.id);
        const bOwned = ownedIds.has(b.g.id);
        if (aOwned !== bOwned) return aOwned ? -1 : 1;
        if (b.score !== a.score) return b.score - a.score;
        const am = a.g.memberCount ?? 0;
        const bm = b.g.memberCount ?? 0;
        if (bm !== am) return bm - am;
        return b.g.id.localeCompare(a.g.id);
      });

    const slice = ranked.slice(offset, offset + lim).map((r) => r.g);
    const nextCursor = offset + lim < ranked.length ? String(offset + lim) : null;

    if (!params.viewerUserId) {
      return {
        data: slice.map((g) => toCommunityGroupShellDto(g, null)),
        pagination: { nextCursor },
      };
    }
    return {
      data: slice.map((g) => {
        const m = membershipByGroup.get(g.id);
        const viewerMembership = m ? { status: m.status, role: m.role } : null;
        return toCommunityGroupShellDto(g, viewerMembership);
      }),
      pagination: { nextCursor },
    };
  }

  /**
   * Explore discovery: a richly-stacked spotlight that should never come back
   * empty when the system has groups the viewer can plausibly join.
   *
   * **Page 1 (no cursor)** is a tiered waterfall:
   *   1. Featured (admin-curated, ordered by featuredOrder)
   *   2. Trending — most posts in the last 14 days (community heat signal)
   *   3. Popular — top by memberCount (steady-state size signal)
   *   4. Recent — newest groups (long-tail discovery, prevents emptiness)
   *
   * **Page 2+ (with cursor)** drops the curated overlays and degrades to a
   * simple `(memberCount desc, id desc)` keyset scan. Once the user has
   * already seen the spotlight, "more" is just a sorted catalog — we don't
   * re-curate on every fetch.
   *
   * `excludeMine` filters out groups the viewer is already an active member
   * of. The cap (`take`, default 24) is the upper bound after dedup; the
   * actual count is whatever's available — never artificially padded.
   * `nextCursor` is set whenever we hit `take` rows; the client paginates
   * until it's null.
   */
  async listExploreSpotlight(
    viewerUserId: string | null,
    opts: { excludeMine?: boolean; take?: number; cursor?: string | null } = {},
  ) {
    const take = Math.min(Math.max(opts.take ?? 24, 1), 60);
    const excludeMine = Boolean(opts.excludeMine && viewerUserId);
    const decodedCursor = decodeGroupCursor(opts.cursor ?? null);

    // Pre-compute the viewer's active group IDs once so each tier / cursor
    // page can exclude them server-side. Empty when not authed or excludeMine
    // is false.
    let mineIds: string[] = [];
    if (excludeMine && viewerUserId) {
      const mine = await this.prisma.communityGroupMember.findMany({
        where: { userId: viewerUserId, status: 'active' },
        select: { groupId: true },
      });
      mineIds = mine.map((m) => m.groupId);
    }
    const baseExclude: Prisma.CommunityGroupWhereInput = { deletedAt: null };

    // Helper: build a where clause that excludes BOTH the viewer's groups
    // and any IDs already chosen in earlier tiers. We merge into a single
    // `notIn` list because Prisma's plain `where` is an AND of properties,
    // and using `{ ...baseExclude, id: {...} }` would *overwrite* an
    // existing `id` filter rather than intersect with it — which previously
    // caused `mineIds` to be silently dropped from Tier 3/4 the moment any
    // featured/trending row landed in `seenIds`. Using one combined `notIn`
    // makes the intent explicit and impossible to clobber.
    const buildExcludeWhere = (
      extra: ReadonlySet<string>,
    ): Prisma.CommunityGroupWhereInput => {
      const exclude = new Set<string>(mineIds);
      for (const id of extra) exclude.add(id);
      return exclude.size > 0
        ? { ...baseExclude, id: { notIn: [...exclude] } }
        : { ...baseExclude };
    };

    // ─── Subsequent pages: simple memberCount-desc keyset ────────────────
    // The waterfall is intentionally a one-shot first-page treatment. Once
    // the user is paginating, give them a homogeneous catalog ordered by
    // popularity so the cursor is meaningful.
    if (decodedCursor) {
      const cursorWhere: Prisma.CommunityGroupWhereInput = {
        OR: [
          { memberCount: { lt: decodedCursor.memberCount } },
          { memberCount: decodedCursor.memberCount, id: { lt: decodedCursor.id } },
        ],
      };
      const rows = await this.prisma.communityGroup.findMany({
        where: { AND: [buildExcludeWhere(new Set()), cursorWhere] },
        orderBy: [{ memberCount: 'desc' }, { id: 'desc' }],
        take: take + 1,
      });
      const hasMore = rows.length > take;
      const slice = hasMore ? rows.slice(0, take) : rows;
      const last = slice[slice.length - 1];
      const nextCursor = hasMore && last
        ? encodeGroupCursor({ memberCount: last.memberCount, id: last.id })
        : null;
      return {
        data: await this.attachExploreMembership(slice, viewerUserId),
        pagination: { nextCursor },
      };
    }

    // ─── First page: tiered waterfall ────────────────────────────────────
    // Tier 1: Featured (curated)
    const featured = await this.prisma.communityGroup.findMany({
      where: { ...buildExcludeWhere(new Set()), isFeatured: true },
      orderBy: [{ featuredOrder: 'asc' }, { createdAt: 'asc' }],
      take: Math.min(take, 8),
    });
    const seenIds = new Set(featured.map((g) => g.id));

    // Tier 2: Trending — most posts in the last 14d. Single GROUP BY query.
    let trending: Array<typeof featured[number]> = [];
    if (seenIds.size < take) {
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const heat = await this.prisma.post.groupBy({
        by: ['communityGroupId'],
        where: {
          deletedAt: null,
          createdAt: { gte: since },
          communityGroupId: { not: null, ...(mineIds.length ? { notIn: mineIds } : {}) },
        },
        _count: { _all: true },
        orderBy: { _count: { communityGroupId: 'desc' } },
        take: Math.max(take, 24),
      });
      const heatIds = heat
        .map((h) => h.communityGroupId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && !seenIds.has(id));
      if (heatIds.length) {
        // AND-merge so the `in: heatIds` filter doesn't clobber the
        // `notIn: mineIds` baseline (heatIds is already pre-filtered above,
        // but we keep the gate explicit so this stays correct under refactor).
        const rows = await this.prisma.communityGroup.findMany({
          where: { AND: [buildExcludeWhere(new Set()), { id: { in: heatIds } }] },
        });
        // Re-order by heat (Prisma findMany doesn't preserve `in` order)
        const order = new Map(heatIds.map((id, i) => [id, i] as const));
        trending = rows
          .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
          .slice(0, take - seenIds.size);
        for (const g of trending) seenIds.add(g.id);
      }
    }

    // Tier 3: Popular by memberCount
    let popular: Array<typeof featured[number]> = [];
    if (seenIds.size < take) {
      popular = await this.prisma.communityGroup.findMany({
        where: buildExcludeWhere(seenIds),
        orderBy: [{ memberCount: 'desc' }, { createdAt: 'desc' }],
        take: take - seenIds.size,
      });
      for (const g of popular) seenIds.add(g.id);
    }

    // Tier 4: Recent (long tail; ensures we never come back empty if anything exists)
    let recent: Array<typeof featured[number]> = [];
    if (seenIds.size < take) {
      recent = await this.prisma.communityGroup.findMany({
        where: buildExcludeWhere(seenIds),
        orderBy: [{ createdAt: 'desc' }],
        take: take - seenIds.size,
      });
    }

    const rows = [...featured, ...trending, ...popular, ...recent];
    // Only emit a cursor when we hit the cap — if all four tiers combined
    // produced fewer than `take` rows, the catalog is genuinely exhausted.
    const last = rows[rows.length - 1];
    const nextCursor = rows.length >= take && last
      ? encodeGroupCursor({ memberCount: last.memberCount, id: last.id })
      : null;
    return {
      data: await this.attachExploreMembership(rows, viewerUserId),
      pagination: { nextCursor },
    };
  }

  /**
   * Annotate a set of rows with the viewer's membership (status + role) for
   * the explore surface. Pulled out of `listExploreSpotlight` so both the
   * waterfall and cursor branches can share it.
   */
  private async attachExploreMembership(
    rows: Array<{ id: string }>,
    viewerUserId: string | null,
  ): Promise<ReturnType<typeof toCommunityGroupShellDto>[]> {
    if (!viewerUserId || rows.length === 0) {
      return rows.map((g) => toCommunityGroupShellDto(g as never, null));
    }
    const memberships = await this.prisma.communityGroupMember.findMany({
      where: { userId: viewerUserId, groupId: { in: rows.map((r) => r.id) } },
      select: { groupId: true, status: true, role: true },
    });
    const byGroup = new Map(memberships.map((m) => [m.groupId, m] as const));
    return rows.map((g) => {
      const m = byGroup.get(g.id);
      const viewerMembership = m ? { status: m.status, role: m.role } : null;
      return toCommunityGroupShellDto(g as never, viewerMembership);
    });
  }
}
