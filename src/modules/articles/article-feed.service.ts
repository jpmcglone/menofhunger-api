import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { AppConfigService } from "../app/app-config.service";
import { ArticleViewsService } from "../article-views/article-views.service";
import { articleIncludes, articleR2BaseUrl } from "./articles.includes";
import { ForbiddenException } from "@nestjs/common";
import type { PostVisibility } from "@prisma/client";
import { toArticleDto, type ArticleWithAuthor } from "../../common/dto/article.dto";
import { toPage } from "../../common/pagination/page";
import { normalizeTag } from "../../common/text/normalize";
import { NOT_DELETED } from '../../common/prisma/where';


@Injectable()
export class ArticleFeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewer: ViewerContextService,
    private readonly appConfig: AppConfigService,
    private readonly articleViews: ArticleViewsService,
  ) {}

  async listPublishedRaw(
    opts: {
      viewerUserId?: string | null;
      limit?: number;
      cursor?: string | null;
      authorUsername?: string | null;
      sort?: "new" | "trending" | null;
      visibilityFilter?: PostVisibility | null;
      mine?: boolean | null;
      followingOnly?: boolean | null;
      tag?: string | null;
      includeRestricted?: boolean | null;
      includeBody?: boolean | null;
    },
    limit: number,
    sort: string,
  ) {
    const viewerCtx = opts.viewerUserId
      ? await this.viewer.getViewer(opts.viewerUserId)
      : null;
    const allowedVisibilities = this.viewer.allowedPostVisibilities(viewerCtx);

    // followingOnly / mine with no authenticated viewer returns nothing
    if ((opts.followingOnly || opts.mine) && !opts.viewerUserId) {
      return { articles: [], nextCursor: null };
    }

    if (
      !opts.includeRestricted &&
      opts.visibilityFilter &&
      !allowedVisibilities.includes(opts.visibilityFilter)
    ) {
      if (opts.visibilityFilter === "verifiedOnly") {
        throw new ForbiddenException("Verify to view verified-only posts.");
      }
      if (opts.visibilityFilter === "premiumOnly") {
        throw new ForbiddenException(
          "Upgrade to premium to view premium-only posts.",
        );
      }
    }

    const effectiveVisibilities = opts.visibilityFilter
      ? [opts.visibilityFilter]
      : allowedVisibilities;

    const normalizedAuthorUsername = (opts.authorUsername ?? "").trim();

    const authorFilter = opts.mine
      ? { authorId: opts.viewerUserId! }
      : normalizedAuthorUsername
        ? {
            author: {
              username: {
                equals: normalizedAuthorUsername,
                mode: "insensitive" as const,
              },
            },
          }
        : opts.followingOnly && opts.viewerUserId
          ? {
              author: {
                followers: { some: { followerId: opts.viewerUserId } },
              },
            }
          : {};

    const tagFilter = opts.tag
      ? { tags: { some: { tag: normalizeTag(opts.tag) } } }
      : {};

    // When includeRestricted is set we normally skip the visibility WHERE so all tiers appear.
    // However, if the caller also provides an explicit visibilityFilter (e.g. the user picked
    // "public only"), honour that filter even in restricted-include mode.
    const visibilityFilter = opts.includeRestricted
      ? opts.visibilityFilter
        ? { visibility: opts.visibilityFilter }
        : {}
      : { visibility: { in: effectiveVisibilities } };

    const toDto = (a: ArticleWithAuthor, viewed: Set<string>) => {
      const viewerCanAccess =
        allowedVisibilities.includes(a.visibility) ||
        a.authorId === opts.viewerUserId;
      return toArticleDto(a, articleR2BaseUrl(this.appConfig), {
        viewerUserId: opts.viewerUserId,
        viewerHasBoosted: opts.viewerUserId
          ? (a.boosts?.length ?? 0) > 0
          : false,
        viewerHasViewed: opts.viewerUserId ? viewed.has(a.id) : undefined,
        viewerCanAccess,
        includeBody: opts.includeBody ?? false,
      });
    };

    const mapItems = async (items: ArticleWithAuthor[]) => {
      const viewed = await this.articleViews.viewerViewedArticleIds(
        opts.viewerUserId,
        items.map((a) => a.id),
      );
      return items.map((a) => toDto(a, viewed));
    };

    if (sort === "trending") {
      // Offset-based for trending (score changes, cursor-based is unreliable).
      // Include all articles regardless of trendingScore; nulls sort last explicitly (Postgres defaults to NULLS FIRST with DESC).
      const skip = opts.cursor ? parseInt(opts.cursor, 10) : 0;
      const articles = (await this.prisma.article.findMany({
        where: {
          isDraft: false,
          ...NOT_DELETED,
          publishedAt: { not: null },
          ...visibilityFilter,
          ...authorFilter,
          ...tagFilter,
        },
        orderBy: [
          { trendingScore: { sort: "desc", nulls: "last" } },
          { publishedAt: "desc" },
        ],
        skip,
        take: limit + 1,
        include: articleIncludes(true, true, opts.viewerUserId),
      })) as ArticleWithAuthor[];

      const { items, nextCursor } = toPage(articles, limit, () =>
        String(skip + limit),
      );

      return { articles: await mapItems(items), nextCursor };
    }

    // Default: newest first, cursor-based
    const articles = (await this.prisma.article.findMany({
      where: {
        isDraft: false,
        ...NOT_DELETED,
        publishedAt: { not: null },
        ...visibilityFilter,
        ...authorFilter,
        ...tagFilter,
        ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
      },
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: articleIncludes(true, true, opts.viewerUserId),
    })) as ArticleWithAuthor[];

    const { items: items, nextCursor: nextCursor } = toPage(
      articles,
      limit,
      (r) => r.id,
    );

    return { articles: await mapItems(items), nextCursor };
  }
}
