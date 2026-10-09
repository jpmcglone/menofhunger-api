import { Injectable } from '@nestjs/common';
import { FollowRelationshipsService } from './follows-relationships.service';
import { blockExclusionSql } from './follows-ranking';
import { Optional } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { PrismaService } from '../prisma/prisma.service';
import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { clampLimit } from '../../common/pagination/page';
import type { UserNotificationPreference } from "../../common/dto/user.dto";
import type { VerifiedStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { toUserListDto } from "../../common/dto";
import { USER_BRIEF_SELECT } from "../../common/prisma-selects/user.select";
import { MEANING_MAX_DISTANCE } from "./follows.shared";
import { type FollowListUser } from "./follows.constants";

@Injectable()
export class FollowMeaningRecommendationsService {
  constructor(
    private readonly relationships: FollowRelationshipsService,
    private readonly appConfig: AppConfigService,
    private readonly prisma: PrismaService,
    @Optional() private readonly embeddings?: EmbeddingsService,
  ) {}

  async recommendUsersByMeaning(params: {
      viewerUserId: string;
      vector: number[];
      limit: number;
    },
  ): Promise<FollowListUser[] | null> {
    if (!this.embeddings?.available()) return null;
    const { viewerUserId } = params;
    const limit = clampLimit(params.limit, { default: 30, max: 30 });
    const near = await this.embeddings
      .nearestUsers(params.vector, {
        limit: limit * 3,
        maxDistance: MEANING_MAX_DISTANCE,
        excludeUserIds: [viewerUserId],
      })
      .catch(() => null);
    if (!near) return null;
    if (near.length === 0) return [];
    const ids = near.map((r) => r.id);
    const [rows, following] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: ids }, usernameIsSet: true, ...NOT_BANNED_USER_WHERE },
        select: {
          ...USER_BRIEF_SELECT,
          premium: true,
          premiumPlus: true,
          isOrganization: true,
          verifiedStatus: true,
          avatarKey: true,
          avatarUpdatedAt: true,
          createdAt: true,
        },
      }),
      this.prisma.follow.findMany({
        where: { followerId: viewerUserId, followingId: { in: ids } },
        select: { followingId: true },
      }),
    ]);
    const followed = new Set(following.map((f) => f.followingId));
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter(
        (r): r is NonNullable<typeof r> => Boolean(r) && !followed.has(r!.id),
      );
    const users = await this.relationships.buildFollowListUsers({
      viewerUserId,
      rows: ordered.slice(0, limit * 2),
    });
    return (await this.relationships.withoutBlocked(viewerUserId, users)).slice(0, limit);
  }

  async listTopUsers(params: { viewerUserId: string | null; limit: number },
  ): Promise<{ users: FollowListUser[] }> {
    const viewerUserId = params.viewerUserId ?? null;
    const limit = clampLimit(params.limit, { default: 50, max: 50 });

    type Row = {
      id: string;
      username: string | null;
      name: string | null;
      premium: boolean;
      premiumPlus: boolean;
      isOrganization: boolean;
      verifiedStatus: VerifiedStatus;
      avatarKey: string | null;
      avatarVideoKey?: string | null;
      avatarVideoDurationMs?: number | null;
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
          ${blockExclusionSql(viewerUserId)}
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
        ? this.relationships.batchRelationshipForUserIds({ viewerUserId, userIds })
        : Promise.resolve({
            viewerFollows: new Set<string>(),
            followsViewer: new Set<string>(),
            viewerNotificationPreferences: new Map<
              string,
              UserNotificationPreference
            >(),
            viewerBellEnabled: new Set<string>(),
          }),
      this.relationships.batchOrgAffiliations(userIds, publicBaseUrl),
    ]);

    const users: FollowListUser[] = rows.map(
      (r) =>
        toUserListDto(r, publicBaseUrl, {
          relationship: {
            viewerFollowsUser: rel.viewerFollows.has(r.id),
            userFollowsViewer: rel.followsViewer.has(r.id),
            viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(r.id),
            viewerNotificationPreference:
              rel.viewerNotificationPreferences.get(r.id) ?? "off",
          },
          orgAffiliations: orgMap.get(r.id) ?? [],
        }) as FollowListUser,
    );

    return { users };
  }
}


