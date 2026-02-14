import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { FollowVisibility, VerifiedStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { NotificationsService } from '../notifications/notifications.service';
import { toUserListDto, type NudgeStateDto } from '../../common/dto';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';

export type FollowRelationship = {
  viewerFollowsUser: boolean;
  userFollowsViewer: boolean;
};

export type FollowSummary = FollowRelationship & {
  canView: boolean;
  followerCount: number | null;
  followingCount: number | null;
  nudge: NudgeStateDto | null;
};

export type FollowListUser = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  verifiedStatus: string;
  avatarUrl: string | null;
  relationship: FollowRelationship;
};

function isVerified(status: VerifiedStatus | string | null | undefined) {
  return Boolean(status && status !== 'none');
}

@Injectable()
export class FollowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly notifications: NotificationsService,
    private readonly presenceRealtime: PresenceRealtimeService,
  ) {}

  /**
   * Recommend users for the viewer to follow.
   *
   * Ranking:
   * - primary: mutual-follow count (friends-of-friends: people the viewer follows who follow the candidate)
   * - fallback: verified/premium/newest users, excluding already-followed
   */
  async recommendUsersToFollow(params: { viewerUserId: string; limit: number }): Promise<{ users: FollowListUser[] }> {
    const { viewerUserId } = params;
    const limit = Math.max(1, Math.min(50, Math.floor(params.limit)));

    type RecRow = {
      id: string;
      username: string | null;
      name: string | null;
      premium: boolean;
      premiumPlus: boolean;
      isOrganization: boolean;
      stewardBadgeEnabled: boolean;
      verifiedStatus: string;
      avatarKey: string | null;
      avatarUpdatedAt: Date | null;
      createdAt: Date;
    };

    const mutualRows = await this.prisma.$queryRaw<Array<RecRow & { mutualCount: number }>>(Prisma.sql`
      WITH viewer_following AS (
        SELECT f1."followingId" AS "userId"
        FROM "Follow" f1
        WHERE f1."followerId" = ${viewerUserId}
      ),
      mutuals AS (
        SELECT
          f2."followingId" AS "userId",
          COUNT(*)::int AS "mutualCount"
        FROM viewer_following vf
        JOIN "Follow" f2 ON f2."followerId" = vf."userId"
        WHERE
          f2."followingId" <> ${viewerUserId}
          AND NOT EXISTS (
            SELECT 1
            FROM "Follow" f3
            WHERE f3."followerId" = ${viewerUserId}
              AND f3."followingId" = f2."followingId"
          )
        GROUP BY f2."followingId"
        ORDER BY "mutualCount" DESC
        LIMIT ${Math.min(500, limit * 25)}
      )
      SELECT
        u."id",
        u."username",
        u."name",
        u."premium",
        u."premiumPlus",
        u."isOrganization",
        u."stewardBadgeEnabled",
        u."verifiedStatus",
        u."avatarKey",
        u."avatarUpdatedAt",
        u."createdAt",
        m."mutualCount"
      FROM mutuals m
      JOIN "User" u ON u."id" = m."userId"
      WHERE u."usernameIsSet" = true
      ORDER BY
        m."mutualCount" DESC,
        (u."verifiedStatus" <> 'none') DESC,
        u."premium" DESC,
        u."createdAt" DESC
      LIMIT ${limit}
    `);

    const selectedIds = new Set(mutualRows.map((r) => r.id));
    const remaining = limit - mutualRows.length;

    const excludeSql = selectedIds.size
      ? Prisma.sql`AND u."id" NOT IN (${Prisma.join([...selectedIds].map((id) => Prisma.sql`${id}`))})`
      : Prisma.sql``;

    const fallbackRows =
      remaining > 0
        ? await this.prisma.$queryRaw<Array<RecRow>>(Prisma.sql`
            SELECT
              u."id",
              u."username",
              u."name",
              u."premium",
              u."premiumPlus",
              u."isOrganization",
              u."stewardBadgeEnabled",
              u."verifiedStatus",
              u."avatarKey",
              u."avatarUpdatedAt",
              u."createdAt"
            FROM "User" u
            WHERE
              u."usernameIsSet" = true
              AND u."id" <> ${viewerUserId}
              ${excludeSql}
              AND NOT EXISTS (
                SELECT 1
                FROM "Follow" f
                WHERE f."followerId" = ${viewerUserId}
                  AND f."followingId" = u."id"
              )
            ORDER BY
              (u."verifiedStatus" <> 'none') DESC,
              u."premium" DESC,
              u."createdAt" DESC
            LIMIT ${remaining}
          `)
        : [];

    const rows: RecRow[] = [...mutualRows, ...fallbackRows];
    if (rows.length === 0) return { users: [] };

    const rel = await this.batchRelationshipForUserIds({ viewerUserId, userIds: rows.map((r) => r.id) });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const users: FollowListUser[] = rows.map((r) =>
      toUserListDto(r, publicBaseUrl, {
        relationship: {
          viewerFollowsUser: rel.viewerFollows.has(r.id),
          userFollowsViewer: rel.followsViewer.has(r.id),
        },
      }) as FollowListUser,
    );

    return { users };
  }

  /**
   * Public-friendly “top users” list (used when logged out).
   * Ranking: verified/premium/newest.
   * When viewer is present, exclude self and already-followed users.
   */
  async listTopUsers(params: { viewerUserId: string | null; limit: number }): Promise<{ users: FollowListUser[] }> {
    const viewerUserId = params.viewerUserId ?? null;
    const limit = Math.max(1, Math.min(50, Math.floor(params.limit)));

    type Row = {
      id: string;
      username: string | null;
      name: string | null;
      premium: boolean;
      premiumPlus: boolean;
      isOrganization: boolean;
      stewardBadgeEnabled: boolean;
      verifiedStatus: string;
      avatarKey: string | null;
      avatarUpdatedAt: Date | null;
      createdAt: Date;
    };

    const whereViewerExclusions = viewerUserId
      ? Prisma.sql`
          AND u."id" <> ${viewerUserId}
          AND NOT EXISTS (
            SELECT 1
            FROM "Follow" f
            WHERE f."followerId" = ${viewerUserId}
              AND f."followingId" = u."id"
          )
        `
      : Prisma.sql``;

    const rows = await this.prisma.$queryRaw<Array<Row>>(Prisma.sql`
      SELECT
        u."id",
        u."username",
        u."name",
        u."premium",
        u."premiumPlus",
        u."isOrganization",
        u."stewardBadgeEnabled",
        u."verifiedStatus",
        u."avatarKey",
        u."avatarUpdatedAt",
        u."createdAt"
      FROM "User" u
      WHERE
        u."usernameIsSet" = true
        ${whereViewerExclusions}
      ORDER BY
        (u."verifiedStatus" <> 'none') DESC,
        u."premiumPlus" DESC,
        u."premium" DESC,
        u."createdAt" DESC
      LIMIT ${limit}
    `);

    if (rows.length === 0) return { users: [] };

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const rel = viewerUserId
      ? await this.batchRelationshipForUserIds({ viewerUserId, userIds: rows.map((r) => r.id) })
      : { viewerFollows: new Set<string>(), followsViewer: new Set<string>() };

    const users: FollowListUser[] = rows.map((r) =>
      toUserListDto(r, publicBaseUrl, {
        relationship: {
          viewerFollowsUser: rel.viewerFollows.has(r.id),
          userFollowsViewer: rel.followsViewer.has(r.id),
        },
      }) as FollowListUser,
    );

    return { users };
  }

  private async viewerById(viewerUserId: string | null) {
    if (!viewerUserId) return null;
    return await this.prisma.user.findUnique({
      where: { id: viewerUserId },
      select: { id: true, verifiedStatus: true, premium: true },
    });
  }

  private canViewFollowInfo(params: {
    viewer: { id: string; verifiedStatus: VerifiedStatus; premium: boolean } | null;
    targetUserId: string;
    followVisibility: FollowVisibility;
  }) {
    const { viewer, targetUserId, followVisibility } = params;
    const isSelf = Boolean(viewer && viewer.id === targetUserId);
    if (isSelf) return true;
    if (followVisibility === 'all') return true;
    if (followVisibility === 'none') return false;
    if (followVisibility === 'verified') return Boolean(viewer && isVerified(viewer.verifiedStatus));
    if (followVisibility === 'premium') return Boolean(viewer && viewer.premium);
    return false;
  }

  private async userByUsernameOrThrow(username: string) {
    const normalized = (username ?? '').trim();
    if (!normalized) throw new NotFoundException('User not found.');

    const user = await this.prisma.user.findFirst({
      where: {
        usernameIsSet: true,
        username: { equals: normalized, mode: 'insensitive' },
      },
      select: { id: true, username: true, followVisibility: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  private async getNudgeState(params: { viewerUserId: string; targetUserId: string }): Promise<NudgeStateDto> {
    const { viewerUserId, targetUserId } = params;
    const pendingMs = 24 * 60 * 60 * 1000; // 24h
    const since = new Date(Date.now() - pendingMs);

    const [lastOutbound, inbound] = await Promise.all([
      this.prisma.notification.findFirst({
        where: {
          kind: 'nudge',
          actorUserId: viewerUserId,
          recipientUserId: targetUserId,
          createdAt: { gte: since },
        },
        select: { createdAt: true, readAt: true, ignoredAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.notification.findFirst({
        where: {
          kind: 'nudge',
          actorUserId: targetUserId,
          recipientUserId: viewerUserId,
          readAt: null,
          createdAt: { gte: since },
        },
        select: { id: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    const hasInboundAfterOutbound = lastOutbound
      ? Boolean(
          await this.prisma.notification.findFirst({
            where: {
              kind: 'nudge',
              actorUserId: targetUserId,
              recipientUserId: viewerUserId,
              createdAt: { gt: lastOutbound.createdAt },
            },
            select: { id: true },
          }),
        )
      : false;

    // Outbound is pending (blocks re-nudge) if:
    // - the viewer nudged within the last 24h, AND
    // - the target has not nudged back after that, AND
    // - the target has not acknowledged it via “Got it” (readAt set without ignoredAt).
    const acknowledgedByGotIt = Boolean(lastOutbound?.readAt && !lastOutbound?.ignoredAt);
    const outboundPending = Boolean(lastOutbound && !hasInboundAfterOutbound && !acknowledgedByGotIt);

    return {
      outboundPending,
      inboundPending: Boolean(inbound),
      inboundNotificationId: inbound?.id ?? null,
      outboundExpiresAt: outboundPending ? new Date(lastOutbound!.createdAt.getTime() + pendingMs).toISOString() : null,
    };
  }

  async follow(params: { viewerUserId: string; username: string }) {
    const { viewerUserId, username } = params;
    const target = await this.userByUsernameOrThrow(username);
    if (target.id === viewerUserId) throw new BadRequestException('You cannot follow yourself.');

    let created = false;
    try {
      await this.prisma.follow.create({
        data: { followerId: viewerUserId, followingId: target.id },
      });
      created = true;
    } catch (err: unknown) {
      // Idempotent: ignore unique violations.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // noop
      } else {
        throw err;
      }
    }

    if (created) {
      const followNotifyWithinMs = 24 * 60 * 60 * 1000; // 24h: avoid spam if they unfollow then follow again
      const alreadyNotified = await this.notifications.hasRecentFollowNotification(
        target.id,
        viewerUserId,
        followNotifyWithinMs,
      );
      if (!alreadyNotified) {
        this.notifications
          .create({
            recipientUserId: target.id,
            kind: 'follow',
            actorUserId: viewerUserId,
            subjectUserId: viewerUserId,
            title: 'followed you',
          })
          .catch(() => {});
      }
    }

    // Cross-tab/device sync for the actor (self only).
    this.presenceRealtime.emitFollowsChanged(viewerUserId, {
      actorUserId: viewerUserId,
      targetUserId: target.id,
      viewerFollowsUser: true,
    });

    return {
      success: true,
      viewerFollowsUser: true,
    };
  }

  async unfollow(params: { viewerUserId: string; username: string }) {
    const { viewerUserId, username } = params;
    const target = await this.userByUsernameOrThrow(username);
    if (target.id === viewerUserId) throw new BadRequestException('You cannot unfollow yourself.');

    await this.prisma.follow.deleteMany({
      where: { followerId: viewerUserId, followingId: target.id },
    });

    // Remove follow notification(s) if present (user unfollowed).
    this.notifications.deleteFollowNotification(target.id, viewerUserId).catch(() => {});

    // Cross-tab/device sync for the actor (self only).
    this.presenceRealtime.emitFollowsChanged(viewerUserId, {
      actorUserId: viewerUserId,
      targetUserId: target.id,
      viewerFollowsUser: false,
    });

    return {
      success: true,
      viewerFollowsUser: false,
    };
  }

  async nudge(params: { viewerUserId: string; username: string }): Promise<{
    sent: boolean;
    blocked: boolean;
    nextAllowedAt: string | null;
  }> {
    const { viewerUserId, username } = params;
    const target = await this.userByUsernameOrThrow(username);
    if (target.id === viewerUserId) throw new BadRequestException('You cannot nudge yourself.');

    // Only allow nudges between mutual follows. If not mutual, hide this surface (404).
    const [a, b] = await Promise.all([
      this.prisma.follow.findFirst({
        where: { followerId: viewerUserId, followingId: target.id },
        select: { id: true },
      }),
      this.prisma.follow.findFirst({
        where: { followerId: target.id, followingId: viewerUserId },
        select: { id: true },
      }),
    ]);
    const viewerFollowsUser = Boolean(a);
    const userFollowsViewer = Boolean(b);
    if (!viewerFollowsUser || !userFollowsViewer) throw new NotFoundException('Not found.');

    const pendingMs = 24 * 60 * 60 * 1000; // 24h
    const since = new Date(Date.now() - pendingMs);

    const lastOutbound = await this.prisma.notification.findFirst({
      where: {
        kind: 'nudge',
        recipientUserId: target.id,
        actorUserId: viewerUserId,
        createdAt: { gte: since },
      },
      select: { createdAt: true, readAt: true, ignoredAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (lastOutbound) {
      const acknowledgedByGotIt = Boolean(lastOutbound.readAt && !lastOutbound.ignoredAt);
      const inboundAfter = await this.prisma.notification.findFirst({
        where: {
          kind: 'nudge',
          actorUserId: target.id,
          recipientUserId: viewerUserId,
          createdAt: { gt: lastOutbound.createdAt },
        },
        select: { id: true },
      });
      if (!inboundAfter && !acknowledgedByGotIt) {
        const nextAllowedAt = new Date(lastOutbound.createdAt.getTime() + pendingMs);
        return {
          sent: false,
          blocked: true,
          nextAllowedAt: nextAllowedAt.toISOString(),
        };
      }
    }

    // Await creation so subsequent reads (profile/preview) are immediately consistent.
    // This is still best-effort for UX, but avoids the “Nudged → Nudge again” flicker caused by async writes.
    await this.notifications.create({
      recipientUserId: target.id,
      kind: 'nudge',
      actorUserId: viewerUserId,
      subjectUserId: viewerUserId,
      title: 'nudged you',
    });

    return {
      sent: true,
      blocked: false,
      nextAllowedAt: new Date(Date.now() + pendingMs).toISOString(),
    };
  }

  async status(params: { viewerUserId: string | null; username: string }): Promise<FollowRelationship> {
    const { viewerUserId, username } = params;
    const target = await this.userByUsernameOrThrow(username);
    if (!viewerUserId) return { viewerFollowsUser: false, userFollowsViewer: false };

    const [a, b] = await Promise.all([
      this.prisma.follow.findFirst({
        where: { followerId: viewerUserId, followingId: target.id },
        select: { id: true },
      }),
      this.prisma.follow.findFirst({
        where: { followerId: target.id, followingId: viewerUserId },
        select: { id: true },
      }),
    ]);

    return {
      viewerFollowsUser: Boolean(a),
      userFollowsViewer: Boolean(b),
    };
  }

  async summary(params: { viewerUserId: string | null; username: string }): Promise<FollowSummary> {
    const { viewerUserId, username } = params;
    const target = await this.userByUsernameOrThrow(username);
    const viewer = await this.viewerById(viewerUserId);

    const relationship = await this.status({ viewerUserId, username });
    const mutual = Boolean(relationship.viewerFollowsUser && relationship.userFollowsViewer);
    const nudge =
      viewerUserId && mutual ? await this.getNudgeState({ viewerUserId, targetUserId: target.id }) : null;
    const canView = this.canViewFollowInfo({
      viewer,
      targetUserId: target.id,
      followVisibility: target.followVisibility,
    });

    if (!canView) {
      return {
        ...relationship,
        canView: false,
        followerCount: null,
        followingCount: null,
        nudge,
      };
    }

    const [followerCount, followingCount] = await Promise.all([
      this.prisma.follow.count({ where: { followingId: target.id, follower: { usernameIsSet: true } } }),
      this.prisma.follow.count({ where: { followerId: target.id, following: { usernameIsSet: true } } }),
    ]);

    return {
      ...relationship,
      canView: true,
      followerCount,
      followingCount,
      nudge,
    };
  }

  async myFollowingCount(params: { viewerUserId: string }): Promise<number> {
    const { viewerUserId } = params;
    // Follow targets always require `usernameIsSet=true` at creation time, but keep the filter
    // here anyway so the count matches the intent everywhere.
    return await this.prisma.follow.count({
      where: { followerId: viewerUserId, following: { usernameIsSet: true } },
    });
  }

  async batchRelationshipForUserIds(params: { viewerUserId: string | null; userIds: string[] }) {
    const { viewerUserId, userIds } = params;
    if (!viewerUserId || userIds.length === 0) {
      return {
        viewerFollows: new Set<string>(),
        followsViewer: new Set<string>(),
      };
    }

    const [viewerFollowing, usersFollowingViewer] = await Promise.all([
      this.prisma.follow.findMany({
        where: { followerId: viewerUserId, followingId: { in: userIds } },
        select: { followingId: true },
      }),
      this.prisma.follow.findMany({
        where: { followingId: viewerUserId, followerId: { in: userIds } },
        select: { followerId: true },
      }),
    ]);

    return {
      viewerFollows: new Set(viewerFollowing.map((r) => r.followingId)),
      followsViewer: new Set(usersFollowingViewer.map((r) => r.followerId)),
    };
  }

  async listFollowers(params: {
    viewerUserId: string | null;
    username: string;
    limit: number;
    cursor: string | null;
  }) {
    const { viewerUserId, username, limit, cursor } = params;
    const target = await this.userByUsernameOrThrow(username);
    const viewer = await this.viewerById(viewerUserId);

    const canView = this.canViewFollowInfo({
      viewer,
      targetUserId: target.id,
      followVisibility: target.followVisibility,
    });
    if (!canView) throw new NotFoundException('Not found.');

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.follow.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const rows = await this.prisma.follow.findMany({
      where: {
        AND: [{ followingId: target.id, follower: { usernameIsSet: true } }, ...(cursorWhere ? [cursorWhere] : [])],
      },
      include: {
        follower: {
          select: {
            id: true,
            username: true,
            name: true,
            premium: true,
            premiumPlus: true,
            isOrganization: true,
            stewardBadgeEnabled: true,
            verifiedStatus: true,
            avatarKey: true,
            avatarUpdatedAt: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? slice[slice.length - 1]?.id ?? null : null;

    const followerIds = slice.map((r) => r.followerId);
    const rel = await this.batchRelationshipForUserIds({ viewerUserId, userIds: followerIds });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const users: FollowListUser[] = slice.map((r) =>
      toUserListDto(r.follower, publicBaseUrl, {
        relationship: {
          viewerFollowsUser: rel.viewerFollows.has(r.follower.id),
          userFollowsViewer: rel.followsViewer.has(r.follower.id),
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
  }) {
    const { viewerUserId, username, limit, cursor } = params;
    const target = await this.userByUsernameOrThrow(username);
    const viewer = await this.viewerById(viewerUserId);

    const canView = this.canViewFollowInfo({
      viewer,
      targetUserId: target.id,
      followVisibility: target.followVisibility,
    });
    if (!canView) throw new NotFoundException('Not found.');

    const cursorWhere = await createdAtIdCursorWhere({
      cursor,
      lookup: async (id) => await this.prisma.follow.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });

    const rows = await this.prisma.follow.findMany({
      where: {
        AND: [{ followerId: target.id, following: { usernameIsSet: true } }, ...(cursorWhere ? [cursorWhere] : [])],
      },
      include: {
        following: {
          select: {
            id: true,
            username: true,
            name: true,
            premium: true,
            premiumPlus: true,
            isOrganization: true,
            stewardBadgeEnabled: true,
            verifiedStatus: true,
            avatarKey: true,
            avatarUpdatedAt: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? slice[slice.length - 1]?.id ?? null : null;

    const followingIds = slice.map((r) => r.followingId);
    const rel = await this.batchRelationshipForUserIds({ viewerUserId, userIds: followingIds });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const users: FollowListUser[] = slice.map((r) =>
      toUserListDto(r.following, publicBaseUrl, {
        relationship: {
          viewerFollowsUser: rel.viewerFollows.has(r.following.id),
          userFollowsViewer: rel.followsViewer.has(r.following.id),
        },
      }) as FollowListUser,
    );

    return { users, nextCursor };
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
      },
      select: {
        id: true,
        username: true,
        name: true,
        premium: true,
        premiumPlus: true,
        isOrganization: true,
        stewardBadgeEnabled: true,
        verifiedStatus: true,
        avatarKey: true,
        avatarUpdatedAt: true,
      },
    });

    const rel = await this.batchRelationshipForUserIds({ viewerUserId, userIds: users.map((u) => u.id) });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    return users.map((u) =>
      toUserListDto(u, publicBaseUrl, {
        relationship: {
          viewerFollowsUser: rel.viewerFollows.has(u.id),
          userFollowsViewer: rel.followsViewer.has(u.id),
        },
      }) as FollowListUser,
    );
  }
}

