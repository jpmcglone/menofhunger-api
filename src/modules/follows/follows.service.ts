import type { UserNotificationPreference, UserNotificationPreferencesDto } from '../../common/dto/user.dto';
import { toAvatarVideoDto } from '../../common/dto/avatar-video.dto';
import type { AvatarVideoDto } from '../../common/dto/avatar-video.dto';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import type { FollowVisibility, VerifiedStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import * as crypto from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { RedisService } from '../redis/redis.service';
import { toUserListDto, type NudgeStateDto, type OrgAffiliationDto } from '../../common/dto';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { ViewerContextService, type ViewerContext } from '../viewer/viewer-context.service';
import { PosthogService } from '../../common/posthog/posthog.service';
import { recommendUsersToFollowOn, recommendArenaUsersToFollowOn } from './follows-recommend.query';

import {
  MEANING_MAX_DISTANCE,
  RECOMMENDATION_FRESHNESS_DAYS,
  RECOMMENDATION_JITTER_MAX,
  RECOMMENDATION_MAX_POOL_SIZE,
  RECOMMENDATION_POOL_MULTIPLIER,
  RECOMMENDATION_SAME_STATE_WEIGHT,
  type RecommendationRow,
} from './follows.shared';

export type FollowRelationship = {
  viewerFollowsUser: boolean;
  userFollowsViewer: boolean;
  /** True when viewer enabled reply notifications for this follow (bell icon). */
  viewerPostNotificationsEnabled: boolean;
  viewerNotificationPreference?: UserNotificationPreference;
};

export type FollowSummary = FollowRelationship & {
  canView: boolean;
  followerCount: number | null;
  followingCount: number | null;
  nudge: NudgeStateDto | null;
  /** Social proof: accounts the viewer follows who also follow this user. Null when signed out or self. */
  followedBy: FollowedByPreview | null;
};

/** Up to `FOLLOWED_BY_PREVIEW_LIMIT` names/avatars plus the full count behind them. */
export type FollowedByPreview = {
  users: Array<{
    id: string;
    username: string | null;
    name: string | null;
    avatarUrl: string | null;
    avatarVideo?: AvatarVideoDto | null;
    isOrganization: boolean;
  }>;
  total: number;
};

export const FOLLOWED_BY_PREVIEW_LIMIT = 3;

export type FollowListUser = {
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: VerifiedStatus;
  avatarUrl: string | null; avatarVideo?: AvatarVideoDto | null;
  relationship: FollowRelationship;
};

@Injectable()
export class FollowsService {
  constructor(
    readonly prisma: PrismaService,
    readonly appConfig: AppConfigService,
    private readonly notifications: NotificationsService,
    private readonly sideEffects: SideEffectsService,
    readonly redis: RedisService,
    private readonly presenceRealtime: PresenceRealtimeService,
    readonly viewerContext: ViewerContextService,
    private readonly posthog: PosthogService,
    @Optional() readonly embeddings?: EmbeddingsService,
  ) {}

  recommendationsCacheKey(
    viewerUserId: string,
    limit: number,
    interestKeys: string[] | null,
    seed: string,
  ): string {
    const interestsPart = interestKeys && interestKeys.length > 0
      ? crypto.createHash('sha1').update([...interestKeys].sort().join(',').toLowerCase()).digest('hex').slice(0, 12)
      : 'none';
    const seedPart = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
    return `follows:recs:v2:${viewerUserId}:${limit}:${interestsPart}:${seedPart}`;
  }

  blockExclusionSql(viewerUserId: string): Prisma.Sql {
    return Prisma.sql`
      AND NOT EXISTS (
        SELECT 1
        FROM "UserBlock" ub
        WHERE (ub."blockerId" = ${viewerUserId} AND ub."blockedId" = u."id")
           OR (ub."blockerId" = u."id" AND ub."blockedId" = ${viewerUserId})
      )
    `;
  }

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

  recommendationSeed(seed: string | undefined): string {
    const explicit = (seed ?? '').trim();
    if (explicit) return explicit.slice(0, 80);

    const day = new Date().toISOString().slice(0, 10);
    return `daily:${day}`;
  }

  recommendationPoolLimit(limit: number): number {
    return Math.max(limit, Math.min(RECOMMENDATION_MAX_POOL_SIZE, limit * RECOMMENDATION_POOL_MULTIPLIER));
  }

  recommendationJitter(input: string): number {
    const hex = crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
    return Number.parseInt(hex, 16) / 0xffffffff;
  }

  scoreRecommendationRow(row: RecommendationRow, params: { viewerUserId: string; seed: string }): number {
    const ageMs = Math.max(0, Date.now() - row.createdAt.getTime());
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const freshness = Math.max(0, 1 - ageDays / RECOMMENDATION_FRESHNESS_DAYS) * 4;
    const trust = (row.verifiedStatus !== 'none' ? 8 : 0) + (row.premiumPlus ? 6 : row.premium ? 3 : 0);
    const profileQuality = (row.avatarKey ? 2 : 0) + (row.name?.trim() ? 1 : 0);
    const relevance =
      Math.min(Math.max(row.mutualCount, 0), 5) * 24 +
      Math.min(Math.max(row.overlapCount, 0), 4) * 16 +
      Math.min(Math.max(row.topicOverlapCount ?? 0, 0), 4) * 20 +
      Math.min(Math.max(row.groupOverlapCount ?? 0, 0), 3) * 22 +
      (row.searchedForCandidate ? 28 : 0) +
      (row.followsViewer ? 12 : 0) +
      (row.sameState ? RECOMMENDATION_SAME_STATE_WEIGHT : 0);
    const jitter = this.recommendationJitter(`${params.viewerUserId}:${row.id}:${params.seed}`) * RECOMMENDATION_JITTER_MAX;

    return relevance + trust + profileQuality + freshness + jitter;
  }

  rankRecommendationRows(
    rows: RecommendationRow[],
    params: { viewerUserId: string; seed: string; limit: number },
  ): RecommendationRow[] {
    return [...rows]
      .sort((a, b) => {
        const scoreDiff =
          this.scoreRecommendationRow(b, params) - this.scoreRecommendationRow(a, params);
        if (Math.abs(scoreDiff) > 0.000001) return scoreDiff;
        return b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id);
      })
      .slice(0, params.limit);
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

  async setPostNotificationsEnabled(params: { viewerUserId: string; username: string; enabled?: boolean; preference?: UserNotificationPreference }): Promise<UserNotificationPreferencesDto> {
    const { viewerUserId, username } = params;
    const preference = params.preference ?? (params.enabled ? 'all' : 'posts');
    const target = await this.userByUsernameOrThrow(username);
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
    return recommendUsersToFollowOn(this, params);
  }

  async recommendUsersByMeaning(params: {
    viewerUserId: string;
    vector: number[];
    limit: number;
  }): Promise<FollowListUser[] | null> {
    if (!this.embeddings?.available()) return null;
    const { viewerUserId } = params;
    const limit = Math.max(1, Math.min(30, Math.floor(params.limit)));
    const near = await this.embeddings
      .nearestUsers(params.vector, { limit: limit * 3, maxDistance: MEANING_MAX_DISTANCE, excludeUserIds: [viewerUserId] })
      .catch(() => null);
    if (!near) return null;
    if (near.length === 0) return [];
    const ids = near.map((r) => r.id);
    const [rows, following] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: ids }, usernameIsSet: true, bannedAt: null },
        select: { id: true, username: true, name: true, premium: true, premiumPlus: true, isOrganization: true, verifiedStatus: true, avatarKey: true, avatarUpdatedAt: true, createdAt: true },
      }),
      this.prisma.follow.findMany({ where: { followerId: viewerUserId, followingId: { in: ids } }, select: { followingId: true } }),
    ]);
    const followed = new Set(following.map((f) => f.followingId));
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    const ordered = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => Boolean(r) && !followed.has(r!.id));
    const users = await this.buildFollowListUsers({ viewerUserId, rows: ordered.slice(0, limit * 2) });
    return (await this.withoutBlocked(viewerUserId, users)).slice(0, limit);
  }

  /**
   * Returns users who share interests with the viewer (arena overlap), excluding
   * users the viewer already follows. Users are ranked by overlap count descending.
   * Falls back to the standard recommendations if there are not enough arena matches.
   */
  async recommendArenaUsersToFollow(params: {
    viewerUserId: string;
    interestKeys: string[];
    limit: number;
    seed?: string;
  }): Promise<{ users: FollowListUser[] }> {
    return recommendArenaUsersToFollowOn(this, params);
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
      verifiedStatus: VerifiedStatus;
      avatarKey: string | null; avatarVideoKey?: string | null; avatarVideoDurationMs?: number | null;
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
          ${this.blockExclusionSql(viewerUserId)}
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
        u."verifiedStatus",
        u."avatarKey",
        u."avatarUpdatedAt",
        u."createdAt"
      FROM "User" u
      WHERE
        u."usernameIsSet" = true
        AND u."bannedAt" IS NULL
        ${whereViewerExclusions}
      ORDER BY
        (u."verifiedStatus" <> 'none') DESC,
        u."premiumPlus" DESC,
        u."premium" DESC,
        u."createdAt" DESC
      LIMIT ${limit}
    `);

    if (rows.length === 0) return { users: [] };

    const userIds = rows.map((r) => r.id);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const [rel, orgMap] = await Promise.all([
      viewerUserId
        ? this.batchRelationshipForUserIds({ viewerUserId, userIds })
        : Promise.resolve({ viewerFollows: new Set<string>(), followsViewer: new Set<string>(), viewerNotificationPreferences: new Map<string, UserNotificationPreference>(), viewerBellEnabled: new Set<string>() }),
      this.batchOrgAffiliations(userIds, publicBaseUrl),
    ]);

    const users: FollowListUser[] = rows.map((r) =>
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

    return { users };
  }

  private canViewFollowInfo(params: {
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

  private async userByUsernameOrThrow(username: string) {
    const normalized = (username ?? '').trim();
    if (!normalized) throw new NotFoundException('User not found.');

    const user = await this.prisma.user.findFirst({
      where: {
        usernameIsSet: true,
        bannedAt: null,
        username: { equals: normalized, mode: 'insensitive' },
      },
      select: { id: true, username: true, followVisibility: true, accountKind: true, isOrganization: true },
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

  async follow(params: { viewerUserId: string; username: string; source?: 'starter' | 'member' }) {
    const { viewerUserId, username } = params;
    await this.viewerContext.assertUserIdNotBanned(viewerUserId);
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
    const target = await this.userByUsernameOrThrow(username);
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

  async nudge(params: { viewerUserId: string; username: string }): Promise<{
    sent: boolean;
    blocked: boolean;
    nextAllowedAt: string | null;
  }> {
    const { viewerUserId, username } = params;
    await this.viewerContext.assertUserIdNotBanned(viewerUserId);
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

    // Unverified users may only nudge back — they cannot initiate.
    const viewer = await this.prisma.user.findUnique({
      where: { id: viewerUserId },
      select: { verifiedStatus: true, accountKind: true },
    });
    if (viewer?.accountKind === 'page' || target.accountKind === 'page') {
      throw new NotFoundException('Not found.');
    }
    const viewerIsVerified = viewer?.verifiedStatus !== 'none';
    if (!viewerIsVerified) {
      const inboundFirst = await this.prisma.notification.findFirst({
        where: {
          kind: 'nudge',
          actorUserId: target.id,
          recipientUserId: viewerUserId,
          readAt: null,
          createdAt: { gte: since },
        },
        select: { id: true },
      });
      if (!inboundFirst) {
        throw new ForbiddenException('Unverified users can only nudge back.');
      }
    }

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

    // Deliberately NOT dispatched to the side-effects queue. The cooldown check above reads
    // this exact row, so here the notification IS the feature's state, not a side effect of
    // it — deferring the write would let a double-tap send two nudges. It's a single indexed
    // insert, and the expensive part (the push) is already queued inside the writer.
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
    const target = await this.userByUsernameOrThrow(username);
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
        bannedAt: null,
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
  private async batchOrgAffiliations(userIds: string[], publicBaseUrl: string | null): Promise<Map<string, OrgAffiliationDto[]>> {
    if (userIds.length === 0) return new Map();
    const memberships = await this.prisma.userOrgMembership.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        org: { select: { id: true, username: true, name: true, avatarKey: true, avatarVideoKey: true, avatarVideoDurationMs: true, avatarUpdatedAt: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const map = new Map<string, OrgAffiliationDto[]>();
    for (const m of memberships) {
      const list = map.get(m.userId) ?? [];
      list.push({
        id: m.org.id,
        username: m.org.username,
        name: m.org.name,
        avatarUrl: publicAssetUrl({ publicBaseUrl, key: m.org.avatarKey ?? null, updatedAt: m.org.avatarUpdatedAt ?? null }), avatarVideo: toAvatarVideoDto(m.org, publicBaseUrl),
      });
      map.set(m.userId, list);
    }
    return map;
  }

  /**
   * Members of an organization account ("Affiliates"). Ordered newest first, cursored on the
   * member id so the list stays stable while memberships are added.
   */
  async listOrgAffiliates(params: {
    viewerUserId: string | null;
    username: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ users: FollowListUser[]; nextCursor: string | null }> {
    const { viewerUserId, username, limit, cursor } = params;
    const org = await this.userByUsernameOrThrow(username);
    if (!org.isOrganization) throw new NotFoundException('Not found.');

    const after = cursor
      ? await this.prisma.userOrgMembership.findUnique({
          where: { userId_orgId: { userId: cursor, orgId: org.id } },
          select: { createdAt: true, userId: true },
        })
      : null;

    const rows = await this.prisma.userOrgMembership.findMany({
      where: {
        orgId: org.id,
        user: { usernameIsSet: true, bannedAt: null },
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
      orderBy: [{ createdAt: 'desc' }, { userId: 'desc' }],
      take: limit + 1,
    });

    const slice = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? (slice[slice.length - 1]?.userId ?? null) : null;

    const rel = await this.batchRelationshipForUserIds({
      viewerUserId,
      userIds: slice.map((row) => row.userId),
    });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    const users: FollowListUser[] = slice.map((row) =>
      toUserListDto(row.user, publicBaseUrl, {
        relationship: {
          viewerFollowsUser: rel.viewerFollows.has(row.userId),
          userFollowsViewer: rel.followsViewer.has(row.userId),
          viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(row.userId),
          viewerNotificationPreference: rel.viewerNotificationPreferences.get(row.userId) ?? 'off',
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
  }) {
    const { viewerUserId, username, limit, cursor } = params;
    const target = await this.userByUsernameOrThrow(username);
    const viewer = await this.viewerContext.getViewer(viewerUserId);

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
        AND: [
          { followingId: target.id, follower: { usernameIsSet: true, bannedAt: null } },
          ...(cursorWhere ? [cursorWhere] : []),
        ],
      },
      include: {
        follower: { select: USER_LIST_SELECT },
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
          viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(r.follower.id),
          viewerNotificationPreference: rel.viewerNotificationPreferences.get(r.follower.id) ?? 'off',
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
    const viewer = await this.viewerContext.getViewer(viewerUserId);

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
        AND: [
          { followerId: target.id, following: { usernameIsSet: true, bannedAt: null } },
          ...(cursorWhere ? [cursorWhere] : []),
        ],
      },
      include: {
        following: { select: USER_LIST_SELECT },
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
          viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(r.following.id),
          viewerNotificationPreference: rel.viewerNotificationPreferences.get(r.following.id) ?? 'off',
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
        bannedAt: null,
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

