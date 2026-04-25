import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { FollowVisibility } from '@prisma/client';
import { Prisma } from '@prisma/client';
import * as crypto from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisService } from '../redis/redis.service';
import { toUserListDto, type NudgeStateDto, type OrgAffiliationDto } from '../../common/dto';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { ViewerContextService, type ViewerContext } from '../viewer/viewer-context.service';
import { PosthogService } from '../../common/posthog/posthog.service';

const RECOMMENDATIONS_CACHE_TTL_SECONDS = 5 * 60;
const RECOMMENDATION_POOL_MULTIPLIER = 8;
const RECOMMENDATION_MAX_POOL_SIZE = 200;
const RECOMMENDATION_JITTER_MAX = 7;
const RECOMMENDATION_FRESHNESS_DAYS = 90;

type RecommendationRow = {
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
  mutualCount: number;
  overlapCount: number;
  followsViewer: boolean;
};

export type FollowRelationship = {
  viewerFollowsUser: boolean;
  userFollowsViewer: boolean;
  /** True when viewer enabled “every post” notifications for this follow (bell icon). */
  viewerPostNotificationsEnabled: boolean;
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
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: string;
  avatarUrl: string | null;
  relationship: FollowRelationship;
};

@Injectable()
export class FollowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly viewerContext: ViewerContextService,
    private readonly posthog: PosthogService,
  ) {}

  private recommendationsCacheKey(
    viewerUserId: string,
    limit: number,
    interestKeys: string[] | null,
    seed: string,
  ): string {
    const interestsPart = interestKeys && interestKeys.length > 0
      ? crypto.createHash('sha1').update([...interestKeys].sort().join(',').toLowerCase()).digest('hex').slice(0, 12)
      : 'none';
    const seedPart = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
    return `follows:recs:${viewerUserId}:${limit}:${interestsPart}:${seedPart}`;
  }

  private recommendationSeed(seed: string | undefined): string {
    const explicit = (seed ?? '').trim();
    if (explicit) return explicit.slice(0, 80);

    const day = new Date().toISOString().slice(0, 10);
    return `daily:${day}`;
  }

  private recommendationPoolLimit(limit: number): number {
    return Math.max(limit, Math.min(RECOMMENDATION_MAX_POOL_SIZE, limit * RECOMMENDATION_POOL_MULTIPLIER));
  }

  private recommendationJitter(input: string): number {
    const hex = crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
    return Number.parseInt(hex, 16) / 0xffffffff;
  }

  private scoreRecommendationRow(row: RecommendationRow, params: { viewerUserId: string; seed: string }): number {
    const ageMs = Math.max(0, Date.now() - row.createdAt.getTime());
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const freshness = Math.max(0, 1 - ageDays / RECOMMENDATION_FRESHNESS_DAYS) * 4;
    const trust = (row.verifiedStatus !== 'none' ? 8 : 0) + (row.premiumPlus ? 6 : row.premium ? 3 : 0);
    const profileQuality = (row.avatarKey ? 2 : 0) + (row.name?.trim() ? 1 : 0);
    const relevance =
      Math.min(Math.max(row.mutualCount, 0), 5) * 24 +
      Math.min(Math.max(row.overlapCount, 0), 4) * 16 +
      (row.followsViewer ? 12 : 0);
    const jitter = this.recommendationJitter(`${params.viewerUserId}:${row.id}:${params.seed}`) * RECOMMENDATION_JITTER_MAX;

    return relevance + trust + profileQuality + freshness + jitter;
  }

  private rankRecommendationRows(
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

  private async buildFollowListUsers(params: {
    viewerUserId: string;
    rows: Array<Pick<RecommendationRow, 'id' | 'username' | 'name' | 'premium' | 'premiumPlus' | 'isOrganization' | 'stewardBadgeEnabled' | 'verifiedStatus' | 'avatarKey' | 'avatarUpdatedAt' | 'createdAt'>>;
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
        },
        orgAffiliations: orgMap.get(r.id) ?? [],
      }) as FollowListUser,
    );
  }

  async setPostNotificationsEnabled(params: { viewerUserId: string; username: string; enabled: boolean }) {
    const { viewerUserId, username, enabled } = params;
    const target = await this.userByUsernameOrThrow(username);
    if (target.id === viewerUserId) throw new BadRequestException('You cannot update post notifications for yourself.');

    // Hide this surface unless the viewer is following the target (404).
    const updated = await this.prisma.follow.updateMany({
      where: { followerId: viewerUserId, followingId: target.id },
      data: { postNotificationsEnabled: Boolean(enabled) },
    });
    if (updated.count === 0) throw new NotFoundException('Not found.');

    return { enabled: Boolean(enabled) };
  }

  /**
   * Recommend users for the viewer to follow.
   *
   * Ranking:
   * - build a larger eligible pool than requested
   * - score mutual follows, shared interests, inbound follows, trust, profile quality, and capped freshness
   * - apply small seeded jitter so refresh can vary without letting weak candidates jump strong ones
   */
  async recommendUsersToFollow(params: {
    viewerUserId: string;
    limit: number;
    seed?: string;
  }): Promise<{ users: FollowListUser[] }> {
    const { viewerUserId } = params;
    const limit = Math.max(1, Math.min(50, Math.floor(params.limit)));
    const seed = this.recommendationSeed(params.seed);
    const poolLimit = this.recommendationPoolLimit(limit);

    const cacheKey = this.recommendationsCacheKey(viewerUserId, limit, null, seed);
    try {
      const cached = await this.redis.getJson<FollowListUser[]>(cacheKey);
      if (cached) return { users: cached };
    } catch { /* Redis unavailable */ }

    const rows = await this.prisma.$queryRaw<RecommendationRow[]>(Prisma.sql`
      WITH viewer AS (
        SELECT u."interests"
        FROM "User" u
        WHERE u."id" = ${viewerUserId}
      ),
      viewer_following AS (
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
        LIMIT ${Math.min(1000, poolLimit * 10)}
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
        COALESCE(m."mutualCount", 0)::int AS "mutualCount",
        COALESCE(
          array_length(
            ARRAY(SELECT unnest(u."interests") INTERSECT SELECT unnest(v."interests")),
            1
          ),
          0
        )::int AS "overlapCount",
        EXISTS (
          SELECT 1
          FROM "Follow" inbound
          WHERE inbound."followerId" = u."id"
            AND inbound."followingId" = ${viewerUserId}
        ) AS "followsViewer"
      FROM "User" u
      CROSS JOIN viewer v
      LEFT JOIN mutuals m ON m."userId" = u."id"
      WHERE u."usernameIsSet" = true
        AND u."bannedAt" IS NULL
        AND u."id" <> ${viewerUserId}
        AND NOT EXISTS (
          SELECT 1
          FROM "Follow" f
          WHERE f."followerId" = ${viewerUserId}
            AND f."followingId" = u."id"
        )
      ORDER BY
        COALESCE(m."mutualCount", 0) DESC,
        "overlapCount" DESC,
        "followsViewer" DESC,
        (u."verifiedStatus" <> 'none') DESC,
        u."premiumPlus" DESC,
        u."premium" DESC,
        u."createdAt" DESC
      LIMIT ${poolLimit}
    `);

    const rankedRows = this.rankRecommendationRows(rows, { viewerUserId, seed, limit });
    const users = await this.buildFollowListUsers({ viewerUserId, rows: rankedRows });

    void this.redis
      .setJson(cacheKey, users, { ttlSeconds: RECOMMENDATIONS_CACHE_TTL_SECONDS })
      .catch(() => undefined);

    return { users };
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
    const { viewerUserId } = params;
    const interestKeys = [...new Set(params.interestKeys.map((key) => key.trim()).filter(Boolean))];
    const limit = Math.max(1, Math.min(50, Math.floor(params.limit)));
    const seed = this.recommendationSeed(params.seed);
    const poolLimit = this.recommendationPoolLimit(limit);

    if (interestKeys.length === 0) {
      return this.recommendUsersToFollow({ viewerUserId, limit, seed });
    }

    const cacheKey = this.recommendationsCacheKey(viewerUserId, limit, interestKeys, seed);
    try {
      const cached = await this.redis.getJson<FollowListUser[]>(cacheKey);
      if (cached) return { users: cached };
    } catch { /* Redis unavailable */ }

    // Use Postgres array overlap (&&) and array_length of the intersection.
    const arenaRows = await this.prisma.$queryRaw<RecommendationRow[]>(Prisma.sql`
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
        COALESCE(
          array_length(
            ARRAY(SELECT unnest(u."interests") INTERSECT SELECT unnest(${interestKeys}::text[])),
            1
          ),
          0
        )::int AS "overlapCount",
        0::int AS "mutualCount",
        EXISTS (
          SELECT 1
          FROM "Follow" inbound
          WHERE inbound."followerId" = u."id"
            AND inbound."followingId" = ${viewerUserId}
        ) AS "followsViewer"
      FROM "User" u
      WHERE
        u."usernameIsSet" = true
        AND u."bannedAt" IS NULL
        AND u."id" <> ${viewerUserId}
        AND u."interests" && ${interestKeys}::text[]
        AND NOT EXISTS (
          SELECT 1
          FROM "Follow" f
          WHERE f."followerId" = ${viewerUserId}
            AND f."followingId" = u."id"
        )
      ORDER BY
        "overlapCount" DESC,
        "followsViewer" DESC,
        (u."verifiedStatus" <> 'none') DESC,
        u."premiumPlus" DESC,
        u."premium" DESC,
        u."createdAt" DESC
      LIMIT ${poolLimit}
    `);

    const rankedArenaRows = this.rankRecommendationRows(arenaRows, { viewerUserId, seed, limit });
    let users = await this.buildFollowListUsers({ viewerUserId, rows: rankedArenaRows });

    if (users.length < limit) {
      // Fall back to padding with regular recommendations.
      const arenaIds = new Set(rankedArenaRows.map((r) => r.id));
      const remaining = limit - users.length;
      const fallback = await this.recommendUsersToFollow({ viewerUserId, limit: remaining + rankedArenaRows.length, seed });
      const fallbackFiltered = fallback.users.filter((u) => !arenaIds.has(u.id)).slice(0, remaining);
      users = [...users, ...fallbackFiltered];
    }

    void this.redis
      .setJson(cacheKey, users, { ttlSeconds: RECOMMENDATIONS_CACHE_TTL_SECONDS })
      .catch(() => undefined);

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
        : Promise.resolve({ viewerFollows: new Set<string>(), followsViewer: new Set<string>(), viewerBellEnabled: new Set<string>() }),
      this.batchOrgAffiliations(userIds, publicBaseUrl),
    ]);

    const users: FollowListUser[] = rows.map((r) =>
      toUserListDto(r, publicBaseUrl, {
        relationship: {
          viewerFollowsUser: rel.viewerFollows.has(r.id),
          userFollowsViewer: rel.followsViewer.has(r.id),
          viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(r.id),
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
      this.posthog.capture(viewerUserId, 'follow_created', { target_user_id: target.id });

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
    if (!viewerUserId) {
      return { viewerFollowsUser: false, userFollowsViewer: false, viewerPostNotificationsEnabled: false };
    }

    const [a, b] = await Promise.all([
      this.prisma.follow.findFirst({
        where: { followerId: viewerUserId, followingId: target.id },
        select: { id: true, postNotificationsEnabled: true },
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
    };
  }

  async summary(params: { viewerUserId: string | null; username: string }): Promise<FollowSummary> {
    const { viewerUserId, username } = params;
    const target = await this.userByUsernameOrThrow(username);
    const viewer = await this.viewerContext.getViewer(viewerUserId);

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
        viewerBellEnabled: new Set<string>(),
      };
    }

    const [viewerFollowing, usersFollowingViewer] = await Promise.all([
      this.prisma.follow.findMany({
        where: { followerId: viewerUserId, followingId: { in: userIds } },
        select: { followingId: true, postNotificationsEnabled: true },
      }),
      this.prisma.follow.findMany({
        where: { followingId: viewerUserId, followerId: { in: userIds } },
        select: { followerId: true },
      }),
    ]);

    return {
      viewerFollows: new Set(viewerFollowing.map((r) => r.followingId)),
      followsViewer: new Set(usersFollowingViewer.map((r) => r.followerId)),
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
        org: { select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true } },
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
        avatarUrl: publicAssetUrl({ publicBaseUrl, key: m.org.avatarKey ?? null, updatedAt: m.org.avatarUpdatedAt ?? null }),
      });
      map.set(m.userId, list);
    }
    return map;
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
        },
      }) as FollowListUser,
    );
  }
}

