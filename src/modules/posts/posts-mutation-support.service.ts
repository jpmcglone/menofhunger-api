import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { AppConfigService } from "../app/app-config.service";
import { CacheInvalidationService } from "../redis/cache-invalidation.service";
import { parseMentionsFromBody as parseMentionsFromBodyText } from "../../common/mentions/mention-regex";
import { parseHashtagTokensFromText, type HashtagToken } from "../../common/hashtags/hashtag-regex";
import { parseCashtagCandidatesFromText } from "../../common/cashtags/cashtag-regex";
import { TickerService } from "../cashtags/ticker.service";
import { easternDayKey, yesterdayEasternDayKey } from "../../common/time/eastern-day-key";
import { computeCheckinStreakStats } from "../checkins/checkin-streaks";
import { PostViewsService } from "../post-views/post-views.service";
import { PosthogService } from "../../common/posthog/posthog.service";
import {
  resolveMentionUsernames as resolveMentionUsernamesQuery,
  resolveMentionUsernamesMap as resolveMentionUsernamesMapQuery,
} from "./posts-mentions.helpers";
import { PostsRankingService } from "./posts-ranking.service";
import { PostsViewerEnrichmentService } from "./posts-viewer-enrichment.service";
import { SiteConfigService } from "../site-config/site-config.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { PostsTopicsClassifyService } from "./posts-topics-classify.service";


@Injectable()
export class PostsMutationSupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly cacheInvalidation: CacheInvalidationService,
    private readonly appConfig: AppConfigService,
    private readonly postViews: PostViewsService,
    private readonly posthog: PosthogService,
    private readonly viewerContextService: ViewerContextService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly ranking: PostsRankingService,
    private readonly ticker: TickerService,
    private readonly siteConfig: SiteConfigService,
    private readonly sideEffects: SideEffectsService,
    private readonly topicsClassify: PostsTopicsClassifyService,
  ) {}
  async recomputeStreakFromPostsTx(
    tx: Prisma.TransactionClient,
    userId: string,
    now: Date,
  ): Promise<void> {
    const posts = await tx.post.findMany({
      where: {
        userId,
        kind: "checkin",
        visibility: { not: "onlyMe" },
        deletedAt: null,
        isDraft: false,
      },
      select: { createdAt: true, checkinDayKey: true },
      orderBy: { createdAt: "asc" },
    });
    const dayKeys = [
      ...new Set(
        posts.map((p) => p.checkinDayKey || easternDayKey(p.createdAt)),
      ),
    ].sort();
    const stats = computeCheckinStreakStats({
      dayKeys,
      todayKey: easternDayKey(now),
      yesterdayKey: yesterdayEasternDayKey(now),
    });
    await tx.user.update({
      where: { id: userId },
      data: {
        checkinStreakDays: stats.currentStreakDays,
        longestStreakDays: stats.longestStreakDays,
        lastCheckinDayKey: stats.lastCheckinDayKey,
      },
    });
  }

  async resolveMentionUsernames(
    usernames: string[],
  ): Promise<string[]> {
    return await resolveMentionUsernamesQuery(this.prisma, usernames);
  }

  /**
   * Resolve a list of @usernames to a lowercased-username → userId map in a single query.
   * Used by createPost to avoid running the same query twice (for body mentions vs. all mentions).
   */
  async resolveMentionUsernamesMap(
    usernames: string[],
  ): Promise<Map<string, string>> {
    return await resolveMentionUsernamesMapQuery(this.prisma, usernames);
  }

  /** Parse @username tokens from body: letter then 0–14 [A-Za-z0-9_] (1–15 chars), not mid-email. */
  parseMentionsFromBody(body: string): string[] {
    return parseMentionsFromBodyText(body);
  }

  /** Parse #hashtag tokens from body: letter then [A-Za-z0-9_], stored lowercase without '#'. */
  parseHashtagsFromBody(body: string): HashtagToken[] {
    return parseHashtagTokensFromText(body);
  }

  /** Parse $SYMBOL candidates from body and return only those present in the ticker universe. */
  parseCashtagsFromBody(body: string): string[] {
    const candidates = parseCashtagCandidatesFromText(body);
    return candidates.filter((s) => this.ticker.isValid(s));
  }
  /**
   * Attempt to extract a local post ID from a URL that looks like
   * `https://menofhunger.com/p/<id>` (or any configured frontend origin).
   * Returns null if the URL does not match.
   */
  tryExtractLocalPostIdFromUrl(raw: string): string | null {
    const s = (raw ?? "").trim();
    if (!s) return null;
    try {
      const u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length !== 2 || parts[0] !== "p") return null;
      const id = (parts[1] ?? "").trim();
      if (!id) return null;
      // Only accept our own known origins to prevent abuse.
      const allowed = new Set<string>();
      allowed.add("menofhunger.com");
      allowed.add("www.menofhunger.com");
      const frontendBase = this.appConfig.frontendBaseUrl()?.trim() ?? "";
      if (frontendBase) {
        try {
          allowed.add(new URL(frontendBase).hostname.toLowerCase());
        } catch {
          /* ignore */
        }
      }
      const host = u.hostname.toLowerCase();
      if (!allowed.has(host) && !host.endsWith(".menofhunger.com")) return null;
      return id;
    } catch {
      return null;
    }
  }

  /** Ascending exclusivity rank matching the shared contract: public < verifiedOnly < premiumOnly < onlyMe. */
  visibilityRank(vis: string): number {
    switch (vis) {
      case "public":
        return 0;
      case "verifiedOnly":
        return 1;
      case "premiumOnly":
        return 2;
      case "onlyMe":
        return 3;
      default:
        return 0;
    }
  }

  /**
   * Scan body text for a local post link and return its ID (or null).
   * Used to populate quotedPostId on new posts.
   */
  extractQuotedPostIdFromBody(body: string): string | null {
    const urlRegex = /https?:\/\/[^\s<>"']+/g;
    const matches = body.match(urlRegex) ?? [];
    // Take the last matching local post link (same as frontend behaviour).
    for (let i = matches.length - 1; i >= 0; i--) {
      const id = this.tryExtractLocalPostIdFromUrl(matches[i]!);
      if (id) return id;
    }
    return null;
  }
}
