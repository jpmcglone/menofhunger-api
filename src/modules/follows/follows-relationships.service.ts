import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import type { UserNotificationPreference } from '../../common/dto/user.dto';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { FollowVisibility } from '@prisma/client';
import { groupOrgAffiliations, toUserListDto, type OrgAffiliationDto } from '../../common/dto';
import { ORG_AFFILIATION_SELECT, USER_LIST_SELECT, USER_REF_SELECT } from '../../common/prisma-selects/user.select';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ViewerContextService, type ViewerContext } from '../viewer/viewer-context.service';
import type { FollowListUser } from './follows.constants';
import type { RecommendationRow } from './follows.shared';

/** Follow edges, relationship batches, and follow-list user hydration shared by the follows collaborators. */
@Injectable()
export class FollowRelationshipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly viewerContext: ViewerContextService,
  ) {}

  /** Cached recommendations predate blocks made since; re-check them on every read. */
  async withoutBlocked(viewerUserId: string, users: FollowListUser[]): Promise<FollowListUser[]> {
    if (users.length === 0) return users;
    const blocks = await this.prisma.userBlock.findMany({
      where: {
        OR: [
          { blockerId: viewerUserId, blockedId: { in: users.map((u) => u.id) } },
          { blockedId: viewerUserId, blockerId: { in: users.map((u) => u.id) } },
        ],
      },
      select: { blockerId: true, blockedId: true },
    });
    if (blocks.length === 0) return users;
    const hidden = new Set(blocks.map((b) => (b.blockerId === viewerUserId ? b.blockedId : b.blockerId)));
    return users.filter((u) => !hidden.has(u.id));
  }

  async buildFollowListUsers(params: {
    viewerUserId: string;
    rows: Array<Pick<RecommendationRow, 'id' | 'username' | 'name' | 'premium' | 'premiumPlus' | 'isOrganization' | 'verifiedStatus' | 'avatarKey' | 'avatarUpdatedAt' | 'createdAt'>>;
  }): Promise<FollowListUser[]> {
    const { viewerUserId, rows } = params;
    if (rows.length === 0) return [];

    const userIds = rows.map((r) => r.id);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const [rel, orgMap] = await Promise.all([
      this.batchRelationshipForUserIds({ viewerUserId, userIds }),
      this.batchOrgAffiliations(userIds, publicBaseUrl),
    ]);

    return rows.map((r) =>
      toUserListDto(r, publicBaseUrl, {
        relationship: {
          viewerFollowsUser: rel.viewerFollows.has(r.id),
          userFollowsViewer: rel.followsViewer.has(r.id),
          viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(r.id),
          viewerNotificationPreference: rel.viewerNotificationPreferences.get(r.id) ?? 'off',
        },
        orgAffiliations: orgMap.get(r.id) ?? [],
      }) as FollowListUser,
    );
  }

  canViewFollowInfo(params: {
    viewer: Pick<ViewerContext, 'id' | 'verifiedStatus' | 'premium' | 'premiumPlus'> | null;
    targetUserId: string;
    followVisibility: FollowVisibility;
  }) {
    const { viewer, targetUserId, followVisibility } = params;
    const isSelf = Boolean(viewer && viewer.id === targetUserId);
    if (isSelf) return true;
    if (followVisibility === 'all') return true;
    if (followVisibility === 'none') return false;
    if (followVisibility === 'verified') return this.viewerContext.isVerified(viewer ?? null);
    if (followVisibility === 'premium') return this.viewerContext.isPremium(viewer ?? null);
    return false;
  }

  async userByUsernameOrThrow(username: string) {
    const normalized = (username ?? '').trim();
    if (!normalized) throw new NotFoundException('User not found.');

    const user = await this.prisma.user.findFirst({
      where: {
        usernameIsSet: true,
        ...NOT_BANNED_USER_WHERE,
        username: { equals: normalized, mode: 'insensitive' },
      },
      select: { ...USER_REF_SELECT, followVisibility: true, accountKind: true, isOrganization: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  async batchRelationshipForUserIds(params: { viewerUserId: string | null; userIds: string[] }) {
    const { viewerUserId, userIds } = params;
    if (!viewerUserId || userIds.length === 0) {
      return {
        viewerFollows: new Set<string>(),
        followsViewer: new Set<string>(),
        viewerNotificationPreferences: new Map<string, UserNotificationPreference>(), viewerBellEnabled: new Set<string>(),
      };
    }

    const [viewerFollowing, usersFollowingViewer] = await Promise.all([
      this.prisma.follow.findMany({
        where: { followerId: viewerUserId, followingId: { in: userIds } },
        select: { followingId: true, postNotificationsEnabled: true, notificationPreference: true },
      }),
      this.prisma.follow.findMany({
        where: { followingId: viewerUserId, followerId: { in: userIds } },
        select: { followerId: true },
      }),
    ]);

    return {
      viewerFollows: new Set(viewerFollowing.map((r) => r.followingId)),
      followsViewer: new Set(usersFollowingViewer.map((r) => r.followerId)),
      viewerNotificationPreferences: new Map(viewerFollowing.map(r => [r.followingId, r.notificationPreference ?? (r.postNotificationsEnabled ? 'all' : 'posts')])),
      viewerBellEnabled: new Set(viewerFollowing.filter((r) => r.postNotificationsEnabled).map((r) => r.followingId)),
    };
  }

  /** Batch-fetch org affiliations for a list of user IDs. Returns a map of userId → OrgAffiliationDto[]. */
  async batchOrgAffiliations(userIds: string[], publicBaseUrl: string | null): Promise<Map<string, OrgAffiliationDto[]>> {
    if (userIds.length === 0) return new Map();
    const memberships = await this.prisma.userOrgMembership.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        org: { select: ORG_AFFILIATION_SELECT },
      },
      orderBy: { createdAt: 'asc' },
    });

    return groupOrgAffiliations(memberships, publicBaseUrl);
  }

  /** Get users by IDs as FollowListUser (for presence/online list). */
  async getFollowListUsersByIds(params: {
    viewerUserId: string | null;
    userIds: string[];
  }): Promise<FollowListUser[]> {
    const { viewerUserId, userIds } = params;
    if (userIds.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: {
        id: { in: userIds },
        usernameIsSet: true,
        ...NOT_BANNED_USER_WHERE,
      },
      select: USER_LIST_SELECT,
    });

    const rel = await this.batchRelationshipForUserIds({ viewerUserId, userIds: users.map((u) => u.id) });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    return users.map((u) =>
      toUserListDto(u, publicBaseUrl, {
        relationship: {
          viewerFollowsUser: rel.viewerFollows.has(u.id),
          userFollowsViewer: rel.followsViewer.has(u.id),
          viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(u.id),
          viewerNotificationPreference: rel.viewerNotificationPreferences.get(u.id) ?? 'off',
        },
      }) as FollowListUser,
    );
  }
}
