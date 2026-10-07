import { Injectable } from '@nestjs/common';
import type { AvatarVideoDto } from "../../common/dto/avatar-video.dto";
import { z } from "zod";
import type { Response } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { FollowsService, type FollowListUser } from "../follows/follows.service";
import type { NudgeStateDto } from "../../common/dto";
import { PublicProfilesService } from "./public-profiles.service";
import { PosthogService } from "../../common/posthog/posthog.service";
import { totalUserArticlesWhere, totalUserBoardPoints, totalUserPostsWhere } from "../../common/content-counts";
import { PostsReadService } from '../posts-read/posts-read.service';
import { MENTION_USER_SELECT } from '../../common/prisma-selects/user.select';

const PREVIEW_BATCH_MAX = 50;
const previewBatchSchema = z.object({
  usernames: z.array(z.string().min(1).max(64)).min(1).max(PREVIEW_BATCH_MAX),
});

type PreviewBatchEntry = {
  username: string;
  id: string | null;
  premium?: boolean;
  premiumPlus?: boolean;
  isOrganization?: boolean;
  verifiedStatus?: string;
};

type UserPreviewPayload = {
  id: string;
  username: string | null;
  name: string | null;
  bio: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  accountKind?: "person" | "page";
  verifiedStatus: string;
  avatarUrl: string | null;
  avatarVideo?: AvatarVideoDto | null;
  bannerUrl: string | null;
  lastOnlineAt: string | null;
  checkinStreakDays: number;
  longestStreakDays: number;
  relationship: { viewerFollowsUser: boolean; userFollowsViewer: boolean };
  nudge: NudgeStateDto | null;
  followerCount: number | null;
  followingCount: number | null;
  viewerHasBlockedUser?: boolean;
  userHasBlockedViewer?: boolean;
  /** The viewer muted this user (their posts and notifications are hidden from the viewer). */
  viewerHasMutedUser?: boolean;
  isBot?: boolean;
  locationDisplay: string | null;
  locationState: string | null;
};

const affiliatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).optional(),
});

/** Public profile, preview, and affiliate reads. */
@Injectable()
export class UsersPublicProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly followsService: FollowsService,
    private readonly publicProfiles: PublicProfilesService,
    private readonly posthog: PosthogService,
    private readonly postsRead: PostsReadService,
  ) {}

  private async viewerCanSeeLastOnline(
    viewerUserId: string | null,
  ): Promise<boolean> {
    if (!viewerUserId) return false;
    try {
      const viewer = await this.prisma.user.findUnique({
        where: { id: viewerUserId },
        select: { verifiedStatus: true, siteAdmin: true },
      });
      const verifiedStatus = (viewer as any)?.verifiedStatus ?? "none";
      return (
        Boolean((viewer as any)?.siteAdmin) ||
        (typeof verifiedStatus === "string" && verifiedStatus !== "none")
      );
    } catch {
      return false;
    }
  }
  async userPreviewBatch(body: unknown) {
    const parsed = previewBatchSchema.parse(body);

    // Normalize + dedupe input (preserve insertion order for the response shape).
    const requested: string[] = [];
    const seen = new Set<string>();
    for (const raw of parsed.usernames) {
      const un = (raw ?? "").toLowerCase().trim();
      if (!un || seen.has(un)) continue;
      seen.add(un);
      requested.push(un);
    }
    if (requested.length === 0)
      return { data: { results: [] as PreviewBatchEntry[] } };

    const rows = await this.prisma.user.findMany({
      where: {
        username: { in: requested, mode: "insensitive" },
        bannedAt: null,
      },
      select: MENTION_USER_SELECT,
    });

    const byLowerUsername = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = (row.username ?? "").toLowerCase().trim();
      if (key) byLowerUsername.set(key, row);
    }

    const results: PreviewBatchEntry[] = requested.map((username) => {
      const found = byLowerUsername.get(username);
      if (!found) return { username, id: null };
      return {
        username,
        id: found.id,
        premium: Boolean(found.premium),
        premiumPlus: Boolean(found.premiumPlus),
        isOrganization: Boolean(found.isOrganization),
        verifiedStatus: String(found.verifiedStatus ?? "none"),
      };
    });

    return { data: { results } };
  }
  async userPreview(
    userId: string | undefined,
    username: string,
    res: Response,
  ) {
    const viewerUserId = userId ?? null;
    const canSeeLastOnline = await this.viewerCanSeeLastOnline(viewerUserId);

    const profileResult = await this.publicProfiles.getByUsernameOrId(username);
    const profile = profileResult.payload;
    if (!this.appConfig.isProd()) {
      res.setHeader("x-moh-cache", `publicProfile=${profileResult.cache}`);
    }
    if ((profile as { banned?: boolean }).banned === true) {
      res.setHeader(
        "Cache-Control",
        "public, max-age=300, stale-while-revalidate=600",
      );
      return { data: { banned: true } };
    }

    let relationship: {
      viewerFollowsUser: boolean;
      userFollowsViewer: boolean;
      viewerPostNotificationsEnabled: boolean;
      viewerNotificationPreference?: import("../../common/dto/user.dto").UserNotificationPreference;
    } = {
      viewerFollowsUser: false,
      userFollowsViewer: false,
      viewerPostNotificationsEnabled: false,
    };
    let nudge: NudgeStateDto | null = null;
    let followerCount: number | null = null;
    let followingCount: number | null = null;

    if (profile.username) {
      const summary = await this.followsService.summary({
        viewerUserId,
        username: profile.username,
      });
      relationship = {
        viewerFollowsUser: summary.viewerFollowsUser,
        userFollowsViewer: summary.userFollowsViewer,
        viewerPostNotificationsEnabled: summary.viewerPostNotificationsEnabled,
        viewerNotificationPreference: summary.viewerNotificationPreference,
      };
      nudge = summary.nudge;
      followerCount = summary.followerCount;
      followingCount = summary.followingCount;
    } else {
      const rel = await this.followsService.batchRelationshipForUserIds({
        viewerUserId,
        userIds: [profile.id],
      });
      relationship = {
        viewerFollowsUser: rel.viewerFollows.has(profile.id),
        userFollowsViewer: rel.followsViewer.has(profile.id),
        viewerPostNotificationsEnabled: rel.viewerBellEnabled.has(profile.id),
        viewerNotificationPreference:
          rel.viewerNotificationPreferences.get(profile.id) ?? "off",
      };
    }

    let viewerHasBlockedUser = false;
    let userHasBlockedViewer = false;
    if (viewerUserId && profile.id && viewerUserId !== profile.id) {
      const blockRows = await this.prisma.userBlock.findMany({
        where: {
          OR: [
            { blockerId: viewerUserId, blockedId: profile.id },
            { blockerId: profile.id, blockedId: viewerUserId },
          ],
        },
        select: { blockerId: true },
      });
      for (const row of blockRows) {
        if (row.blockerId === viewerUserId) viewerHasBlockedUser = true;
        else userHasBlockedViewer = true;
      }
    }
    const viewerHasMutedUser =
      viewerUserId && profile.id && viewerUserId !== profile.id
        ? Boolean(
            await this.prisma.userMute.findUnique({
              where: {
                muterId_mutedId: { muterId: viewerUserId, mutedId: profile.id },
              },
              select: { mutedId: true },
            }),
          )
        : false;

    const payload: UserPreviewPayload = {
      id: profile.id,
      username: profile.username,
      name: profile.name,
      bio: profile.bio,
      premium: profile.premium,
      premiumPlus: profile.premiumPlus,
      isOrganization: Boolean((profile as any).isOrganization),
      accountKind: (profile as any).accountKind === "page" ? "page" : "person",
      verifiedStatus: profile.verifiedStatus,
      avatarUrl: profile.avatarUrl,
      avatarVideo: profile.avatarVideo ?? null,
      bannerUrl: profile.bannerUrl,
      lastOnlineAt: canSeeLastOnline ? (profile.lastOnlineAt ?? null) : null,
      checkinStreakDays: Math.max(
        0,
        Math.floor(Number((profile as any).checkinStreakDays) || 0),
      ),
      longestStreakDays: Math.max(
        0,
        Math.floor(Number((profile as any).longestStreakDays) || 0),
      ),
      relationship,
      nudge,
      followerCount,
      followingCount,
      viewerHasBlockedUser,
      userHasBlockedViewer,
      viewerHasMutedUser,
      isBot: Boolean((profile as any).isBot),
      locationDisplay: (profile as any).locationDisplay ?? null,
      locationState: (profile as any).locationState ?? null,
    };

    // Preview includes viewer-specific relationship when authenticated.
    // Allow longer caching for anonymous reads; authenticated must be private.
    res.setHeader(
      "Cache-Control",
      viewerUserId
        ? "private, max-age=60, stale-while-revalidate=120"
        : "public, max-age=300, stale-while-revalidate=600",
    );
    res.setHeader("Vary", "Cookie");

    const orgMap = await this.publicProfiles.batchOrgAffiliations([payload.id]);
    return {
      data: { ...payload, orgAffiliations: orgMap.get(payload.id) ?? [] },
    };
  }
  async affiliates(
    userId: string | undefined,
    username: string,
    query: unknown,
  ): Promise<{
    data: FollowListUser[];
    pagination: { nextCursor: string | null };
  }> {
    const parsed = affiliatesQuerySchema.parse(query);
    const result = await this.followsService.listOrgAffiliates({
      viewerUserId: userId ?? null,
      username,
      limit: parsed.limit ?? 30,
      cursor: parsed.cursor ?? null,
    });
    return {
      data: result.users,
      pagination: { nextCursor: result.nextCursor },
    };
  }
  async publicProfile(
    userId: string | undefined,
    username: string,
    res: Response,
  ) {
    const viewerUserId = userId ?? null;
    const canSeeLastOnline = await this.viewerCanSeeLastOnline(viewerUserId);
    const profileResult = await this.publicProfiles.getByUsernameOrId(username);
    const payload = profileResult.payload;
    if (!this.appConfig.isProd()) {
      res.setHeader("x-moh-cache", `publicProfile=${profileResult.cache}`);
    }

    if ((payload as { banned?: boolean }).banned === true) {
      res.setHeader(
        "Cache-Control",
        "public, max-age=300, stale-while-revalidate=600",
      );
      return { data: { banned: true } };
    }

    // lastOnlineAt is viewer-sensitive: only verified viewers can see it.
    // Anonymous reads can still be publicly cached since we always redact lastOnlineAt there.
    res.setHeader(
      "Cache-Control",
      viewerUserId
        ? "private, max-age=60, stale-while-revalidate=120"
        : "public, max-age=300, stale-while-revalidate=600",
    );
    if (viewerUserId) res.setHeader("Vary", "Cookie");

    const profileId = (payload as any).id as string | undefined;
    const isOrg = Boolean(
      (payload as { isOrganization?: boolean }).isOrganization,
    );
    const [
      orgMap,
      crewMember,
      postCount,
      articleCount,
      boardPoints,
      affiliateCount,
    ] = await Promise.all([
      profileId
        ? this.publicProfiles.batchOrgAffiliations([profileId])
        : Promise.resolve(new Map()),
      profileId
        ? this.prisma.crewMember.findFirst({
            where: { userId: profileId, crew: { deletedAt: null } },
            select: { crewId: true },
          })
        : Promise.resolve(null),
      profileId
        ? this.postsRead.read.count({ where: totalUserPostsWhere(profileId) })
        : Promise.resolve(0),
      profileId
        ? this.prisma.article.count({
            where: totalUserArticlesWhere(profileId),
          })
        : Promise.resolve(0),
      profileId
        ? totalUserBoardPoints(this.prisma, profileId)
        : Promise.resolve(0),
      // Only organizations have affiliates; everyone else gets null so clients can hide the count.
      profileId && isOrg
        ? this.prisma.userOrgMembership.count({
            where: {
              orgId: profileId,
              user: { usernameIsSet: true, bannedAt: null },
            },
          })
        : Promise.resolve(null),
    ]);

    if (viewerUserId && profileId) {
      this.posthog.capture(viewerUserId, "profile_viewed", {
        viewed_user_id: profileId,
        is_own_profile: viewerUserId === profileId,
      });
    }

    return {
      data: {
        ...(payload as any),
        lastOnlineAt: canSeeLastOnline ? (payload as any).lastOnlineAt : null,
        orgAffiliations: orgMap.get(profileId ?? "") ?? [],
        postCount,
        articleCount,
        boardPoints,
        affiliateCount,
        inCrew: Boolean(crewMember),
      },
    };
  }
}
