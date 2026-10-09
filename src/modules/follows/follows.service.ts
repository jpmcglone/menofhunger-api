import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { isUniqueViolation } from '../../common/prisma/errors';
import type { UserNotificationPreference, UserNotificationPreferencesDto } from '../../common/dto/user.dto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { toUserListDto, type NudgeStateDto } from '../../common/dto';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import { PosthogService } from '../../common/posthog/posthog.service';

import { FOLLOWED_BY_PREVIEW_LIMIT, type FollowRelationship, type FollowSummary, type FollowedByPreview, type FollowListUser } from './follows.constants';
import { FollowRelationshipsService } from './follows-relationships.service';
import { FollowRecommendationsService } from './follows-recommendations.service';
import { FollowMeaningRecommendationsService } from './follows-meaning.service';
import { FollowNudgeService } from './follows-nudge.service';
import { FollowListsService } from './follows-lists.service';
export type { FollowRelationship, FollowSummary, FollowedByPreview, FollowListUser } from './follows.constants';

@Injectable()
export class FollowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly viewerContext: ViewerContextService,
    private readonly sideEffects: SideEffectsService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly posthog: PosthogService,
    private readonly relationships: FollowRelationshipsService,
    private readonly recommendations: FollowRecommendationsService,
    private readonly meaning: FollowMeaningRecommendationsService,
    private readonly nudges: FollowNudgeService,
    private readonly lists: FollowListsService,
  ) {}

  batchRelationshipForUserIds(params: { viewerUserId: string | null; userIds: string[] }) {
    return this.relationships.batchRelationshipForUserIds(params);
  }

  /** Get users by IDs as FollowListUser (for presence/online list). */
  getFollowListUsersByIds(params: { viewerUserId: string | null; userIds: string[] }): Promise<FollowListUser[]> {
    return this.relationships.getFollowListUsersByIds(params);
  }

  async setPostNotificationsEnabled(params: { viewerUserId: string; username: string; enabled?: boolean; preference?: UserNotificationPreference }): Promise<UserNotificationPreferencesDto> {
    const { viewerUserId, username } = params;
    const preference = params.preference ?? (params.enabled ? 'all' : 'posts');
    const target = await this.relationships.userByUsernameOrThrow(username);
    if (target.id === viewerUserId) throw new BadRequestException('You cannot update post notifications for yourself.');

    // Hide this surface unless the viewer is following the target (404).
    const updated = await this.prisma.follow.updateMany({
      where: { followerId: viewerUserId, followingId: target.id },
      data: { notificationPreference: preference, postNotificationsEnabled: preference === 'all' },
    });
    if (updated.count === 0) throw new NotFoundException('Not found.');

    this.presenceRealtime.emitFollowsChanged(viewerUserId, {
      actorUserId: viewerUserId, targetUserId: target.id, viewerFollowsUser: true,
      viewerNotificationPreference: preference,
    });
    return { preference, enabled: preference === 'all' };
  }

  /**
   * Recommend users for the viewer to follow.
   *
   * Ranking:
   * - union mutuals with people who share topics, groups, or a search tap
   * - score those signals, inbound follows, same-state, trust, profile quality, and capped freshness
   * - apply small seeded jitter so refresh can vary without letting weak candidates jump strong ones
   */
  async recommendUsersToFollow(params: {
    viewerUserId: string;
    limit: number;
    seed?: string;
  }): Promise<{ users: FollowListUser[] }> {
    return this.recommendations.recommendUsersToFollow(params);
  }

  async recommendUsersByMeaning(params: { viewerUserId: string; vector: number[]; limit: number }) : Promise<FollowListUser[] | null> {
    return this.meaning.recommendUsersByMeaning(params);
  }

  async recommendArenaUsersToFollow(params: { viewerUserId: string; interestKeys: string[]; limit: number; seed?: string }) : Promise<{ users: FollowListUser[] }> {
    return this.recommendations.recommendArenaUsersToFollow(params);
  }


  async listTopUsers(params: { viewerUserId: string | null; limit: number }) : Promise<{ users: FollowListUser[] }> {
    return this.meaning.listTopUsers(params);
  }

  async getNudgeState(params: { viewerUserId: string; targetUserId: string }) : Promise<NudgeStateDto> {
    return this.nudges.getNudgeState(params);
  }

  async follow(params: { viewerUserId: string; username: string; source?: 'starter' | 'member' }) {
    const { viewerUserId, username } = params;
    await this.viewerContext.assertUserIdNotBanned(viewerUserId);
    const target = await this.relationships.userByUsernameOrThrow(username);
    if (target.id === viewerUserId) throw new BadRequestException('You cannot follow yourself.');

    let created = false;
    try {
      await this.prisma.follow.create({
        data: { followerId: viewerUserId, followingId: target.id },
      });
      created = true;
    } catch (err: unknown) {
      // Idempotent: ignore unique violations.
      if (isUniqueViolation(err)) {
        // noop
      } else {
        throw err;
      }
    }

    if (created) {
      this.posthog.capture(viewerUserId, 'follow_created', { target_user_id: target.id, source: params.source ?? 'member' });
      this.sideEffects.dispatch('follow.created', {
        actorUserId: viewerUserId,
        targetUserId: target.id,
      });
    }

    // Cross-tab/device sync for the actor (self only).
    this.presenceRealtime.emitFollowsChanged(viewerUserId, {
      actorUserId: viewerUserId,
      targetUserId: target.id,
      viewerFollowsUser: true,
      ...(created ? { viewerNotificationPreference: 'all' as const } : {}),
    });

    return {
      success: true,
      viewerFollowsUser: true,
    };
  }

  async unfollow(params: { viewerUserId: string; username: string }) {
    const { viewerUserId, username } = params;
    const target = await this.relationships.userByUsernameOrThrow(username);
    if (target.id === viewerUserId) throw new BadRequestException('You cannot unfollow yourself.');

    await this.prisma.follow.deleteMany({
      where: { followerId: viewerUserId, followingId: target.id },
    });

    this.sideEffects.dispatch('follow.removed', {
      actorUserId: viewerUserId,
      targetUserId: target.id,
    });

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

  async nudge(params: { viewerUserId: string; username: string }) : Promise<{
    sent: boolean;
    blocked: boolean;
    nextAllowedAt: string | null;
  }> {
    return this.nudges.nudge(params);
  }

  async status(params: { viewerUserId: string | null; username: string }): Promise<FollowRelationship> {
    const { viewerUserId, username } = params;
    const target = await this.relationships.userByUsernameOrThrow(username);
    if (!viewerUserId) {
      return { viewerFollowsUser: false, userFollowsViewer: false, viewerPostNotificationsEnabled: false };
    }

    const [a, b] = await Promise.all([
      this.prisma.follow.findFirst({
        where: { followerId: viewerUserId, followingId: target.id },
        select: { id: true, postNotificationsEnabled: true, notificationPreference: true },
      }),
      this.prisma.follow.findFirst({
        where: { followerId: target.id, followingId: viewerUserId },
        select: { id: true },
      }),
    ]);

    return {
      viewerFollowsUser: Boolean(a),
      userFollowsViewer: Boolean(b),
      viewerPostNotificationsEnabled: Boolean(a?.postNotificationsEnabled),
      viewerNotificationPreference: a?.notificationPreference ?? (a ? (a.postNotificationsEnabled ? 'all' : 'posts') : 'off'),
    };
  }

  async summary(params: { viewerUserId: string | null; username: string }): Promise<FollowSummary> {
    const { viewerUserId, username } = params;
    const target = await this.relationships.userByUsernameOrThrow(username);
    const viewer = await this.viewerContext.getViewer(viewerUserId);

    const relationship = await this.status({ viewerUserId, username });
    const mutual = Boolean(relationship.viewerFollowsUser && relationship.userFollowsViewer);
    const nudge =
      viewerUserId &&
      mutual &&
      viewer?.accountKind !== 'page' &&
      target.accountKind !== 'page'
        ? await this.getNudgeState({ viewerUserId, targetUserId: target.id })
        : null;
    const canView = this.relationships.canViewFollowInfo({
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
        followedBy: null,
      };
    }

    const [followerCount, followingCount, followedBy] = await Promise.all([
      this.prisma.follow.count({ where: { followingId: target.id, follower: { usernameIsSet: true } } }),
      this.prisma.follow.count({ where: { followerId: target.id, following: { usernameIsSet: true } } }),
      this.followedByViewerFollows({ viewerUserId, targetUserId: target.id }),
    ]);

    return {
      ...relationship,
      canView: true,
      followerCount,
      followingCount,
      nudge,
      followedBy,
    };
  }

  /**
   * "Followed by X, Y and N others you follow": the intersection of the viewer's following list
   * and this user's followers. Preview names come from the same order the count is taken in, so
   * the copy and the number always agree.
   */
  private async followedByViewerFollows(params: {
    viewerUserId: string | null;
    targetUserId: string;
  }): Promise<FollowedByPreview | null> {
    const { viewerUserId, targetUserId } = params;
    if (!viewerUserId || viewerUserId === targetUserId) return null;

    const where: Prisma.FollowWhereInput = {
      followingId: targetUserId,
      followerId: { not: viewerUserId },
      follower: {
        usernameIsSet: true,
        ...NOT_BANNED_USER_WHERE,
        followers: { some: { followerId: viewerUserId } },
      },
    };

    const [total, rows] = await Promise.all([
      this.prisma.follow.count({ where }),
      this.prisma.follow.findMany({
        where,
        select: { follower: { select: USER_LIST_SELECT } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: FOLLOWED_BY_PREVIEW_LIMIT,
      }),
    ]);
    if (total === 0) return { users: [], total: 0 };

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    return {
      users: rows.map((row) => {
        const dto = toUserListDto(row.follower, publicBaseUrl);
        return {
          id: dto.id,
          username: dto.username,
          name: dto.name,
          avatarUrl: dto.avatarUrl,
          avatarVideo: dto.avatarVideo,
          isOrganization: dto.isOrganization,
        };
      }),
      total,
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

  async listOrgAffiliates(params: { viewerUserId: string | null; username: string; limit: number; cursor: string | null }) : Promise<{ users: FollowListUser[]; nextCursor: string | null }> {
    return this.lists.listOrgAffiliates(params);
  }

  async listFollowers(params: { viewerUserId: string | null; username: string; limit: number; cursor: string | null }) {
    return this.lists.listFollowers(params);
  }

  async listFollowing(params: { viewerUserId: string | null; username: string; limit: number; cursor: string | null }) {
    return this.lists.listFollowing(params);
  }

}

