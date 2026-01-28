import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { FollowVisibility, VerifiedStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type FollowRelationship = {
  viewerFollowsUser: boolean;
  userFollowsViewer: boolean;
};

export type FollowSummary = FollowRelationship & {
  canView: boolean;
  followerCount: number | null;
  followingCount: number | null;
};

export type FollowListUser = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  verifiedStatus: string;
  avatarKey: string | null;
  avatarUpdatedAt: Date | null;
  relationship: FollowRelationship;
};

function isVerified(status: VerifiedStatus | string | null | undefined) {
  return Boolean(status && status !== 'none');
}

@Injectable()
export class FollowsService {
  constructor(private readonly prisma: PrismaService) {}

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

  async follow(params: { viewerUserId: string; username: string }) {
    const { viewerUserId, username } = params;
    const target = await this.userByUsernameOrThrow(username);
    if (target.id === viewerUserId) throw new BadRequestException('You cannot follow yourself.');

    try {
      await this.prisma.follow.create({
        data: { followerId: viewerUserId, followingId: target.id },
      });
    } catch (err: unknown) {
      // Idempotent: ignore unique violations.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // noop
      } else {
        throw err;
      }
    }

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

    return {
      success: true,
      viewerFollowsUser: false,
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
    };
  }

  private async batchRelationshipForUserIds(params: { viewerUserId: string | null; userIds: string[] }) {
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

    const rows = await this.prisma.follow.findMany({
      where: { followingId: target.id, follower: { usernameIsSet: true } },
      include: {
        follower: {
          select: {
            id: true,
            username: true,
            name: true,
            premium: true,
            verifiedStatus: true,
            avatarKey: true,
            avatarUpdatedAt: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? slice[slice.length - 1]?.id ?? null : null;

    const followerIds = slice.map((r) => r.followerId);
    const rel = await this.batchRelationshipForUserIds({ viewerUserId, userIds: followerIds });

    const users: FollowListUser[] = slice.map((r) => ({
      id: r.follower.id,
      username: r.follower.username,
      name: r.follower.name,
      premium: r.follower.premium,
      verifiedStatus: r.follower.verifiedStatus,
      avatarKey: r.follower.avatarKey,
      avatarUpdatedAt: r.follower.avatarUpdatedAt,
      relationship: {
        viewerFollowsUser: rel.viewerFollows.has(r.follower.id),
        userFollowsViewer: rel.followsViewer.has(r.follower.id),
      },
    }));

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

    const rows = await this.prisma.follow.findMany({
      where: { followerId: target.id, following: { usernameIsSet: true } },
      include: {
        following: {
          select: {
            id: true,
            username: true,
            name: true,
            premium: true,
            verifiedStatus: true,
            avatarKey: true,
            avatarUpdatedAt: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? slice[slice.length - 1]?.id ?? null : null;

    const followingIds = slice.map((r) => r.followingId);
    const rel = await this.batchRelationshipForUserIds({ viewerUserId, userIds: followingIds });

    const users: FollowListUser[] = slice.map((r) => ({
      id: r.following.id,
      username: r.following.username,
      name: r.following.name,
      premium: r.following.premium,
      verifiedStatus: r.following.verifiedStatus,
      avatarKey: r.following.avatarKey,
      avatarUpdatedAt: r.following.avatarUpdatedAt,
      relationship: {
        viewerFollowsUser: rel.viewerFollows.has(r.following.id),
        userFollowsViewer: rel.followsViewer.has(r.following.id),
      },
    }));

    return { users, nextCursor };
  }
}

