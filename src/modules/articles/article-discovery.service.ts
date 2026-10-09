import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ViewerContextService } from "../viewer/viewer-context.service";
import { AppConfigService } from "../app/app-config.service";
import { ArticleViewsService } from "../article-views/article-views.service";
import { articleIncludes, articleR2BaseUrl } from "./articles.includes";
import {
  toArticleDto,
  type ArticleWithAuthor,
} from "../../common/dto/article.dto";
import { normalizeTag } from "../../common/text/normalize";
import { NOT_DELETED } from '../../common/prisma/where';

@Injectable()
export class ArticleDiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewer: ViewerContextService,
    private readonly appConfig: AppConfigService,
    private readonly articleViews: ArticleViewsService,
  ) {}

  async listTagSuggestions(
    q: string,
  ): Promise<Array<{ tag: string; label: string; count: number }>> {
    const normalized = normalizeTag(q);

    // Aggregate across all published articles; pick the most-common label per slug.
    const grouped = await this.prisma.articleTag.groupBy({
      by: ["tag"],
      where: {
        ...(normalized ? { tag: { startsWith: normalized } } : {}),
        article: {
          ...NOT_DELETED,
          isDraft: false,
          publishedAt: { not: null },
          visibility: "public",
        },
      },
      _count: { tag: true },
      orderBy: { _count: { tag: "desc" } },
      take: 20,
    });

    if (!grouped.length) return [];

    // For each slug, pick the most-used label variant.
    const labelRows = await this.prisma.articleTag.findMany({
      where: { tag: { in: grouped.map((r) => r.tag) } },
      select: { tag: true, label: true },
    });

    // Count label occurrences per tag slug → pick winner.
    const labelMap = new Map<string, Map<string, number>>();
    for (const r of labelRows) {
      if (!labelMap.has(r.tag)) labelMap.set(r.tag, new Map());
      const m = labelMap.get(r.tag)!;
      m.set(r.label, (m.get(r.label) ?? 0) + 1);
    }

    return grouped.map((g) => {
      const variants = labelMap.get(g.tag);
      let bestLabel = g.tag;
      if (variants) {
        let bestCount = 0;
        for (const [label, count] of variants) {
          if (count > bestCount) {
            bestLabel = label;
            bestCount = count;
          }
        }
      }
      return { tag: g.tag, label: bestLabel, count: g._count.tag };
    });
  }

  async listTrending(opts: {
    viewerUserId?: string | null;
    limit?: number;
    /** When the 7-day scored set is short, backfill from older published articles. */
    fillIfShort?: boolean;
    includeBody?: boolean;
  }) {
    const limit = Math.min(opts.limit ?? 5, 20);
    const viewerCtx = opts.viewerUserId
      ? await this.viewer.getViewer(opts.viewerUserId)
      : null;
    const allowedVisibilities = this.viewer.allowedPostVisibilities(viewerCtx);
    const include = articleIncludes(true, true, opts.viewerUserId);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const recent = (await this.prisma.article.findMany({
      where: {
        isDraft: false,
        ...NOT_DELETED,
        publishedAt: { gte: sevenDaysAgo },
        visibility: { in: allowedVisibilities },
        trendingScore: { not: null },
      },
      orderBy: [{ trendingScore: "desc" }, { publishedAt: "desc" }],
      take: limit,
      include,
    })) as ArticleWithAuthor[];

    let articles = recent;
    if (opts.fillIfShort && recent.length < limit) {
      const extra = (await this.prisma.article.findMany({
        where: {
          isDraft: false,
          ...NOT_DELETED,
          publishedAt: { not: null },
          visibility: { in: allowedVisibilities },
          id: { notIn: recent.map((article) => article.id) },
        },
        orderBy: [
          { trendingScore: { sort: "desc", nulls: "last" } },
          { publishedAt: "desc" },
        ],
        take: limit - recent.length,
        include,
      })) as ArticleWithAuthor[];
      articles = recent.concat(extra);
    }

    const viewed = await this.articleViews.viewerViewedArticleIds(
      opts.viewerUserId,
      articles.map((a) => a.id),
    );
    return articles.map((a) =>
      toArticleDto(a, articleR2BaseUrl(this.appConfig), {
        viewerUserId: opts.viewerUserId,
        viewerHasBoosted: opts.viewerUserId
          ? (a.boosts?.length ?? 0) > 0
          : false,
        viewerHasViewed: opts.viewerUserId ? viewed.has(a.id) : undefined,
        includeBody: opts.includeBody ?? false,
      }),
    );
  }
}
