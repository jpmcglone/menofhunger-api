import { Injectable } from '@nestjs/common';
import { FollowRelationshipsService } from './follows-relationships.service';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { NotFoundException } from "@nestjs/common";
import { toUserListDto } from "../../common/dto";
import { USER_LIST_SELECT } from "../../common/prisma-selects/user.select";
import { createdAtIdCursorWhere } from "../../common/pagination/created-at-id-cursor";
import { toPage } from "../../common/pagination/page";
import { type FollowListUser } from "./follows.constants";

@Injectable()
export class FollowListsService {
  constructor(
    private readonly relationships: FollowRelationshipsService,
    private readonly appConfig: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly viewerContext: ViewerContextService,
  ) {}

  async listOrgAffiliates(params: {
      viewerUserId: string | null;
      username: string;
      limit: number;
      cursor: string | null;
    },
  ): Promise<{ users: FollowListUser[]; nextCursor: string | null }> {
    const { viewerUserId, username, limit, cursor } = params;
    const org = await this.relationships.userByUsernameOrThrow(username);
    if (!org.isOrganization) throw new NotFoundException("Not found.");

    const after = cursor
      ? await this.prisma.userOrgMembership.findUnique({
          where: { userId_orgId: { userId: cursor, orgId: org.id } },
          select: { createdAt: true, userId: true },
        })
      : null;

    const rows = await this.prisma.userOrgMembership.findMany({
      where: {
        orgId: org.id,
        user: { usernameIsSet: true, ...NOT_BANNED_USER_WHERE },
        ...(after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, userId: { lt: after.userId } },
              ],
            }
          : {}),
      },
      select: { userId: true, user: { select: USER_LIST_SELECT } },
      orderBy: [{ createdAt: "desc" }, { userId: "desc" }],
      take: limit + 1,
    });

    const { items: slice, nextCursor: nextCursor } = toPage(
      rows,
      limit,
      (r) => r.userId,
    );

    const rel = await this.relationships.batchRelationshipForUserIds({
      viewerUserId,
      userIds: slice.map((row) => row.userId),
    });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const users: FollowListUser[] = slice.map(
      (row) =>
        toUserListDto(row.user, publicBaseUrl, {
          relationship: {
            viewerFollowsUser: rel.viewerFollows.has(row.userId),
            userFollowsViewer: rel.followsViewer.has(row.userId),
            viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(row.userId),
            viewerNotificationPreference:
              rel.viewerNotificationPreferences.get(row.userId) ?? "off",
          },
        }) as FollowListUser,
    );

    return { users, nextCursor };
  }

  async listFollowers(params: {
      viewerUserId: string | null;
      username: string;
      limit: number;
      cursor: string | null;
    },
  ) {
    const { viewerUserId, username, limit, cursor } = params;
    const target = await this.relationships.userByUsernameOrThrow(username);
    const viewer = await this.viewerContext.getViewer(viewerUserId);

    const canView = this.relationships.canViewFollowInfo({
      viewer,
      targetUserId: target.id,
      followVisibility: target.followVisibility,
    });
    if (!canView) throw new NotFoundException("Not found.");

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) =>
        await this.prisma.follow.findUnique({
          where: { id },
          select: { id: true, createdAt: true },
        }),
    });

    const rows = await this.prisma.follow.findMany({
      where: {
        AND: [
          {
            followingId: target.id,
            follower: { usernameIsSet: true, ...NOT_BANNED_USER_WHERE },
          },
          ...(cursorWhere ? [cursorWhere] : []),
        ],
      },
      include: {
        follower: { select: USER_LIST_SELECT },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const { items: slice, nextCursor: nextCursor } = toPage(
      rows,
      limit,
      (r) => r.id,
    );

    const followerIds = slice.map((r) => r.followerId);
    const rel = await this.relationships.batchRelationshipForUserIds({
      viewerUserId,
      userIds: followerIds,
    });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const users: FollowListUser[] = slice.map(
      (r) =>
        toUserListDto(r.follower, publicBaseUrl, {
          relationship: {
            viewerFollowsUser: rel.viewerFollows.has(r.follower.id),
            userFollowsViewer: rel.followsViewer.has(r.follower.id),
            viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(
              r.follower.id,
            ),
            viewerNotificationPreference:
              rel.viewerNotificationPreferences.get(r.follower.id) ?? "off",
          },
        }) as FollowListUser,
    );

    return { users, nextCursor };
  }

  async listFollowing(params: {
      viewerUserId: string | null;
      username: string;
      limit: number;
      cursor: string | null;
    },
  ) {
    const { viewerUserId, username, limit, cursor } = params;
    const target = await this.relationships.userByUsernameOrThrow(username);
    const viewer = await this.viewerContext.getViewer(viewerUserId);

    const canView = this.relationships.canViewFollowInfo({
      viewer,
      targetUserId: target.id,
      followVisibility: target.followVisibility,
    });
    if (!canView) throw new NotFoundException("Not found.");

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) =>
        await this.prisma.follow.findUnique({
          where: { id },
          select: { id: true, createdAt: true },
        }),
    });

    const rows = await this.prisma.follow.findMany({
      where: {
        AND: [
          {
            followerId: target.id,
            following: { usernameIsSet: true, ...NOT_BANNED_USER_WHERE },
          },
          ...(cursorWhere ? [cursorWhere] : []),
        ],
      },
      include: {
        following: { select: USER_LIST_SELECT },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const { items: slice, nextCursor: nextCursor } = toPage(
      rows,
      limit,
      (r) => r.id,
    );

    const followingIds = slice.map((r) => r.followingId);
    const rel = await this.relationships.batchRelationshipForUserIds({
      viewerUserId,
      userIds: followingIds,
    });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const users: FollowListUser[] = slice.map(
      (r) =>
        toUserListDto(r.following, publicBaseUrl, {
          relationship: {
            viewerFollowsUser: rel.viewerFollows.has(r.following.id),
            userFollowsViewer: rel.followsViewer.has(r.following.id),
            viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(
              r.following.id,
            ),
            viewerNotificationPreference:
              rel.viewerNotificationPreferences.get(r.following.id) ?? "off",
          },
        }) as FollowListUser,
    );

    return { users, nextCursor };
  }
}



