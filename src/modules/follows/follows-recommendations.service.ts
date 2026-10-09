import { Injectable } from '@nestjs/common';
import { FollowRelationshipsService } from './follows-relationships.service';
import { blockExclusionSql, rankRecommendationRows, recommendationPoolLimit, recommendationSeed, recommendationsCacheKey } from './follows-ranking';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { clampLimit } from '../../common/pagination/page';
import { Prisma } from '@prisma/client';
import type { FollowListUser } from './follows.constants';
import {
  AFFINITY_POST_DAYS,
  AFFINITY_SEARCH_DAYS,
  mergedPoolUserTopicsSql,
  paddedMatchesPhraseSql,
  topicPhrasesCteSql,
  viewerGroupNameTopicsSql,
  viewerPostTopicsSql,
  viewerSearchTopicsSql,
} from '../../common/discovery/user-affinity.sql';
import {
  RECOMMENDATION_MAX_POOL_SIZE,
  RECOMMENDATIONS_CACHE_TTL_SECONDS,
  type RecommendationRow,
} from './follows.shared';

@Injectable()
export class FollowRecommendationsService {
  constructor(
    private readonly relationships: FollowRelationshipsService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async recommendUsersToFollow(params: {
    viewerUserId: string;
    limit: number;
    seed?: string;
  }): Promise<{ users: FollowListUser[] }> {
    const { viewerUserId } = params;
    const limit = clampLimit(params.limit, { default: 50, max: 50 });
    const seed = recommendationSeed(params.seed);
    const poolLimit = recommendationPoolLimit(limit);
    const affinityLimit = Math.min(RECOMMENDATION_MAX_POOL_SIZE, poolLimit * 2);

    const cacheKey = recommendationsCacheKey(viewerUserId, limit, null, seed);
    try {
      const cached = await this.redis.getJson<FollowListUser[]>(cacheKey);
      if (cached) return { users: await this.relationships.withoutBlocked(viewerUserId, cached) };
    } catch { /* Redis unavailable */ }

    const rows = await this.prisma.$queryRaw<RecommendationRow[]>(Prisma.sql`
      WITH
      ${topicPhrasesCteSql()},
      viewer AS (
        SELECT u."interests", u."locationState"
        FROM "User" u
        WHERE u."id" = ${viewerUserId}
      ),
      viewer_topics AS (
        SELECT ARRAY(
          SELECT DISTINCT s.t
          FROM (
            SELECT unnest(v."interests") AS t
            FROM viewer v
            UNION
            SELECT unnest(${viewerPostTopicsSql(viewerUserId, AFFINITY_POST_DAYS)})
            UNION
            SELECT unnest(${viewerSearchTopicsSql(viewerUserId, AFFINITY_SEARCH_DAYS)})
            UNION
            SELECT unnest(${viewerGroupNameTopicsSql(viewerUserId)})
          ) s
          WHERE s.t IS NOT NULL AND btrim(s.t) <> ''
        ) AS topics
      ),
      viewer_groups AS (
        SELECT cgm."groupId"
        FROM "CommunityGroupMember" cgm
        JOIN "CommunityGroup" g ON g."id" = cgm."groupId" AND g."deletedAt" IS NULL
        WHERE cgm."userId" = ${viewerUserId}
          AND cgm."status" = 'active'
        UNION
        SELECT us."targetGroupId"
        FROM "UserSearch" us
        WHERE us."userId" = ${viewerUserId}
          AND us."targetGroupId" IS NOT NULL
          AND us."createdAt" > NOW() - (${AFFINITY_SEARCH_DAYS}::int * INTERVAL '1 day')
      ),
      viewer_search_users AS (
        SELECT DISTINCT us."targetUserId" AS "userId"
        FROM "UserSearch" us
        WHERE us."userId" = ${viewerUserId}
          AND us."targetUserId" IS NOT NULL
          AND us."createdAt" > NOW() - (${AFFINITY_SEARCH_DAYS}::int * INTERVAL '1 day')
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
      ),
      affinity_posts AS (
        SELECT DISTINCT p."userId"
        FROM "Post" p
        CROSS JOIN viewer_topics vt
        WHERE p."deletedAt" IS NULL
          AND p."visibility" = 'public'
          AND p."createdAt" > NOW() - (${AFFINITY_POST_DAYS}::int * INTERVAL '1 day')
          AND cardinality(p."topics") > 0
          AND p."topics" && vt."topics"
          AND p."userId" <> ${viewerUserId}
        LIMIT ${affinityLimit}
      ),
      affinity_interests AS (
        SELECT u."id" AS "userId"
        FROM "User" u
        CROSS JOIN viewer_topics vt
        WHERE u."usernameIsSet" = true
          AND u."bannedAt" IS NULL
          AND u."id" <> ${viewerUserId}
          AND u."interests" && vt."topics"
          AND NOT EXISTS (
            SELECT 1
            FROM "Follow" f
            WHERE f."followerId" = ${viewerUserId}
              AND f."followingId" = u."id"
          )
        LIMIT ${affinityLimit}
      ),
      affinity_groups AS (
        SELECT DISTINCT cgm."userId"
        FROM "CommunityGroupMember" cgm
        JOIN "CommunityGroup" g ON g."id" = cgm."groupId" AND g."deletedAt" IS NULL
        WHERE cgm."status" = 'active'
          AND cgm."userId" <> ${viewerUserId}
          AND cgm."groupId" IN (SELECT vg."groupId" FROM viewer_groups vg)
      ),
      pool AS (
        SELECT "userId" FROM mutuals
        UNION
        SELECT "userId" FROM affinity_posts
        UNION
        SELECT "userId" FROM affinity_interests
        UNION
        SELECT "userId" FROM affinity_groups
        UNION
        SELECT "userId" FROM viewer_search_users
      ),
      pool_post_topics AS (
        SELECT p."userId", ARRAY_AGG(DISTINCT t) AS topics
        FROM "Post" p
        JOIN pool po ON po."userId" = p."userId"
        CROSS JOIN LATERAL UNNEST(p."topics") AS t
        WHERE p."deletedAt" IS NULL
          AND p."visibility" = 'public'
          AND p."createdAt" > NOW() - (${AFFINITY_POST_DAYS}::int * INTERVAL '1 day')
          AND cardinality(p."topics") > 0
        GROUP BY p."userId"
      ),
      pool_group_topics AS (
        SELECT cgm."userId", ARRAY_AGG(DISTINCT tp.value) AS topics
        FROM pool po
        JOIN "CommunityGroupMember" cgm ON cgm."userId" = po."userId" AND cgm."status" = 'active'
        JOIN "CommunityGroup" g ON g."id" = cgm."groupId" AND g."deletedAt" IS NULL
        JOIN topic_phrases tp ON ${paddedMatchesPhraseSql(Prisma.sql`g."name"`, Prisma.sql`tp.phrase`)}
        GROUP BY cgm."userId"
      )
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
        u."createdAt",
        COALESCE(m."mutualCount", 0)::int AS "mutualCount",
        COALESCE(
          array_length(
            ARRAY(SELECT unnest(u."interests") INTERSECT SELECT unnest(v."interests")),
            1
          ),
          0
        )::int AS "overlapCount",
        COALESCE(
          array_length(
            ARRAY(
              SELECT unnest(${mergedPoolUserTopicsSql()})
              INTERSECT
              SELECT unnest(vt."topics")
            ),
            1
          ),
          0
        )::int AS "topicOverlapCount",
        (
          SELECT COUNT(*)::int
          FROM "CommunityGroupMember" cgm
          JOIN "CommunityGroup" g ON g."id" = cgm."groupId" AND g."deletedAt" IS NULL
          WHERE cgm."userId" = u."id"
            AND cgm."status" = 'active'
            AND cgm."groupId" IN (SELECT vg."groupId" FROM viewer_groups vg)
        ) AS "groupOverlapCount",
        EXISTS (
          SELECT 1 FROM viewer_search_users vsu WHERE vsu."userId" = u."id"
        ) AS "searchedForCandidate",
        EXISTS (
          SELECT 1
          FROM "Follow" inbound
          WHERE inbound."followerId" = u."id"
            AND inbound."followingId" = ${viewerUserId}
        ) AS "followsViewer",
        (
          NULLIF(TRIM(u."locationState"), '') IS NOT NULL
          AND NULLIF(TRIM(v."locationState"), '') IS NOT NULL
          AND UPPER(TRIM(u."locationState")) = UPPER(TRIM(v."locationState"))
        ) AS "sameState"
      FROM pool p
      JOIN "User" u ON u."id" = p."userId"
      CROSS JOIN viewer v
      CROSS JOIN viewer_topics vt
      LEFT JOIN mutuals m ON m."userId" = u."id"
      LEFT JOIN pool_post_topics ppt ON ppt."userId" = u."id"
      LEFT JOIN pool_group_topics pgt ON pgt."userId" = u."id"
      WHERE u."usernameIsSet" = true
        AND u."bannedAt" IS NULL
        AND u."id" <> ${viewerUserId}
        AND NOT EXISTS (
          SELECT 1
          FROM "Follow" f
          WHERE f."followerId" = ${viewerUserId}
            AND f."followingId" = u."id"
        )
        ${blockExclusionSql(viewerUserId)}
    `);

    const rankedRows = rankRecommendationRows(rows, { viewerUserId, seed, limit });
    const users = await this.relationships.buildFollowListUsers({ viewerUserId, rows: rankedRows });

    void this.redis
      .setJson(cacheKey, users, { ttlSeconds: RECOMMENDATIONS_CACHE_TTL_SECONDS })
      .catch(() => undefined);

    return { users };
  }

  async recommendArenaUsersToFollow(params: {
    viewerUserId: string;
    interestKeys: string[];
    limit: number;
    seed?: string;
  }): Promise<{ users: FollowListUser[] }> {
    const { viewerUserId } = params;
    const interestKeys = [...new Set(params.interestKeys.map((key) => key.trim()).filter(Boolean))];
    const limit = clampLimit(params.limit, { default: 50, max: 50 });
    const seed = recommendationSeed(params.seed);
    const poolLimit = recommendationPoolLimit(limit);

    if (interestKeys.length === 0) {
      return this.recommendUsersToFollow({ viewerUserId, limit, seed });
    }

    const cacheKey = recommendationsCacheKey(viewerUserId, limit, interestKeys, seed);
    try {
      const cached = await this.redis.getJson<FollowListUser[]>(cacheKey);
      if (cached) return { users: await this.relationships.withoutBlocked(viewerUserId, cached) };
    } catch { /* Redis unavailable */ }

    // Use Postgres array overlap (&&) and array_length of the intersection.
    const arenaRows = await this.prisma.$queryRaw<RecommendationRow[]>(Prisma.sql`
      WITH viewer AS (
        SELECT u."locationState"
        FROM "User" u
        WHERE u."id" = ${viewerUserId}
      )
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
        u."createdAt",
        COALESCE(
          array_length(
            ARRAY(SELECT unnest(u."interests") INTERSECT SELECT unnest(${interestKeys}::text[])),
            1
          ),
          0
        )::int AS "overlapCount",
        0::int AS "topicOverlapCount",
        0::int AS "groupOverlapCount",
        false AS "searchedForCandidate",
        0::int AS "mutualCount",
        EXISTS (
          SELECT 1
          FROM "Follow" inbound
          WHERE inbound."followerId" = u."id"
            AND inbound."followingId" = ${viewerUserId}
        ) AS "followsViewer",
        (
          NULLIF(TRIM(u."locationState"), '') IS NOT NULL
          AND NULLIF(TRIM(v."locationState"), '') IS NOT NULL
          AND UPPER(TRIM(u."locationState")) = UPPER(TRIM(v."locationState"))
        ) AS "sameState"
      FROM "User" u
      CROSS JOIN viewer v
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
        ${blockExclusionSql(viewerUserId)}
      ORDER BY
        "overlapCount" DESC,
        "sameState" DESC,
        "followsViewer" DESC,
        (u."verifiedStatus" <> 'none') DESC,
        u."premiumPlus" DESC,
        u."premium" DESC,
        u."createdAt" DESC
      LIMIT ${poolLimit}
    `);

    const rankedArenaRows = rankRecommendationRows(arenaRows, { viewerUserId, seed, limit });
    let users = await this.relationships.buildFollowListUsers({ viewerUserId, rows: rankedArenaRows });

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
}


/**
 * Members whose profile is close in meaning to `vector` (a free-text intent or the viewer's own interests).
 * Excludes the viewer, people already followed, and either direction of block. Null when vectors are unavailable.
 */



