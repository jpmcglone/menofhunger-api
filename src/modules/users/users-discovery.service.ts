import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { Injectable } from '@nestjs/common';
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { FollowsService } from "../follows/follows.service";
import { validateUsername } from "./users.utils";
import { toUserDto } from "./user.dto";
import { toUserListDto } from "../../common/dto";
import { USER_LIST_SELECT } from "../../common/prisma-selects/user.select";
import { UsersMeRealtimeService } from "./users-me-realtime.service";
import { UsersLocationService, STATE_NAMES } from "./users-location.service";
import type { LocationBrowseResponseDto } from "./location-browse.dto";

const newestUsersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const byLocationSchema = z.object({
  state: z.string().trim().min(1).max(100),
  zip: z.string().trim().max(20).optional(),
  city: z.string().trim().max(100).optional(),
  county: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/** Username availability, newest members, and location browsing. */
@Injectable()
export class UsersDiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly followsService: FollowsService,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly usersLocation: UsersLocationService,
  ) {}

  async usernameAvailable(username: string | undefined) {
    const parsed = validateUsername(username ?? "");
    if (!parsed.ok)
      return {
        data: { available: false, normalized: null, error: parsed.error },
      };

    const exists =
      (
        await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "User"
          WHERE LOWER("username") = LOWER(${parsed.username})
          LIMIT 1
        `
      )[0] ?? null;

    return { data: { available: !exists, normalized: parsed.usernameLower } };
  }
  async newest(viewerUserId: string, query: unknown) {
    const parsed = newestUsersSchema.parse(query);
    const limit = parsed.limit ?? 12;

    const rows = await this.prisma.user.findMany({
      where: {
        usernameIsSet: true,
        ...NOT_BANNED_USER_WHERE,
        id: { not: viewerUserId },
        // Exclude users the viewer already follows.
        followers: { none: { followerId: viewerUserId } },
      },
      select: USER_LIST_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });

    const rel = await this.followsService.batchRelationshipForUserIds({
      viewerUserId,
      userIds: rows.map((u) => u.id),
    });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const users = rows.map((u) =>
      toUserListDto(u, publicBaseUrl, {
        relationship: {
          viewerFollowsUser: rel.viewerFollows.has(u.id),
          userFollowsViewer: rel.followsViewer.has(u.id),
          viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(u.id),
          viewerNotificationPreference:
            rel.viewerNotificationPreferences.get(u.id) ?? "off",
        },
      }),
    );

    return { data: users };
  }
  async locationPreview(query: unknown) {
    const { zip } = z.object({ zip: z.string().trim() }).parse(query);
    const result = this.usersLocation.normalizeUsLocation(zip);
    const stateCode = (result.state ?? "").toUpperCase();
    return {
      data: {
        zip: result.zip,
        city: result.city,
        state: result.state,
        stateDisplay: STATE_NAMES[stateCode] ?? result.state,
        display: result.display,
      },
    };
  }
  async skipLocationPrompt(userId: string) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { locationPromptSkipped: true },
    });
    const r2PublicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    void this.usersMeRealtime.emitMeUpdatedFromUser(updated, "profile_changed");
    return { data: { user: toUserDto(updated, r2PublicBaseUrl) } };
  }
  async byLocation(
    viewerUserId: string,
    query: unknown,
  ): Promise<{ data: LocationBrowseResponseDto }> {
    const {
      state,
      zip,
      city,
      county,
      limit = 10,
    } = byLocationSchema.parse(query);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const stateCode = state.toUpperCase();
    const stateDisplay = STATE_NAMES[stateCode] ?? stateCode;

    // The count and every sample use the same viewer visibility policy.
    const baseWhere = {
      usernameIsSet: true,
      ...NOT_BANNED_USER_WHERE,
      blocksInitiated: { none: { blockedId: viewerUserId } },
      blocksReceived: { none: { blockerId: viewerUserId } },
    };

    // State-only queries show all members including the viewer themselves.
    const isStateOnly = !zip && !city && !county;
    const excludedIds = new Set<string>(isStateOnly ? [] : [viewerUserId]);

    const fetchSection = async (where: Record<string, unknown>) => {
      const rows = await this.prisma.user.findMany({
        where: {
          ...baseWhere,
          ...where,
          id: { notIn: Array.from(excludedIds) },
        },
        select: USER_LIST_SELECT,
        // Most active streakers first; oldest/founding members break ties.
        orderBy: [{ checkinStreakDays: "desc" }, { createdAt: "asc" }],
        take: limit,
      });
      rows.forEach((r) => excludedIds.add(r.id));
      return rows;
    };

    // Run sequentially: each section excludes IDs collected by earlier (closer) sections.
    const zipRows = zip ? await fetchSection({ locationZip: zip }) : [];
    const cityRows = city
      ? await fetchSection({ locationCity: city, locationState: stateCode })
      : [];
    const countyRows = county
      ? await fetchSection({ locationCounty: county, locationState: stateCode })
      : [];
    const stateRows = await fetchSection({ locationState: stateCode });
    const memberCount = await this.prisma.user.count({
      where: { ...baseWhere, locationState: stateCode },
    });

    const allRows = [...zipRows, ...cityRows, ...countyRows, ...stateRows];
    const rel = await this.followsService.batchRelationshipForUserIds({
      viewerUserId,
      userIds: allRows.map((u) => u.id),
    });

    const mapUsers = (rows: typeof allRows) =>
      rows.map((u) =>
        toUserListDto(u, publicBaseUrl, {
          relationship: {
            viewerFollowsUser: rel.viewerFollows.has(u.id),
            userFollowsViewer: rel.followsViewer.has(u.id),
            viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(u.id),
            viewerNotificationPreference:
              rel.viewerNotificationPreferences.get(u.id) ?? "off",
          },
        }),
      );

    const sections: LocationBrowseResponseDto["sections"] = [
      ...(zip
        ? [
            {
              key: "sameZip" as const,
              label: "Same ZIP code",
              users: mapUsers(zipRows),
            },
          ]
        : []),
      ...(city
        ? [
            {
              key: "sameCity" as const,
              label: "Same city",
              users: mapUsers(cityRows),
            },
          ]
        : []),
      ...(county
        ? [
            {
              key: "sameCounty" as const,
              label: "Same county",
              users: mapUsers(countyRows),
            },
          ]
        : []),
      {
        key: "sameState" as const,
        label: `Members in ${stateDisplay}`,
        users: mapUsers(stateRows),
      },
    ];

    return {
      data: {
        location: {
          ...(zip ? { zip } : {}),
          ...(city ? { city } : {}),
          ...(county ? { county } : {}),
          state: stateCode,
          stateDisplay,
        },
        memberCount,
        sections,
      },
    };
  }
}
