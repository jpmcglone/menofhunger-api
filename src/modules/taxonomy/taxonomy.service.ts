import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TOPIC_OPTIONS } from '../../common/topics/topic-options';

type SearchTaxonomyParams = {
  q: string;
  limit: number;
};

export type TaxonomySearchResult = {
  id: string;
  slug: string;
  label: string;
  kind: 'topic' | 'subtopic' | 'tag';
  score: number;
  aliases: string[];
};

function normalizeInput(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/[_\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function slugify(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

@Injectable()
export class TaxonomyService {
  private readonly searchCache = new Map<string, { expiresAt: number; data: TaxonomySearchResult[] }>();

  constructor(private readonly prisma: PrismaService) {}

  private setSearchCache(key: string, data: TaxonomySearchResult[]) {
    const now = Date.now();
    // Lightweight eviction: clear expired entries and cap map size to prevent unbounded growth.
    for (const [k, v] of this.searchCache.entries()) {
      if (v.expiresAt <= now) this.searchCache.delete(k);
    }
    if (this.searchCache.size >= 200) {
      const oldestKey = this.searchCache.keys().next().value as string | undefined;
      if (oldestKey) this.searchCache.delete(oldestKey);
    }
    this.searchCache.set(key, { expiresAt: now + 5 * 60_000, data });
  }

  async search(params: SearchTaxonomyParams): Promise<TaxonomySearchResult[]> {
    const q = normalizeInput(params.q);
    const limit = Math.max(1, Math.min(50, params.limit || 10));
    const cacheKey = `${q}::${limit}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
    if (!q) {
      const rows = await this.prisma.taxonomyTerm.findMany({
        where: { status: 'active' },
        include: {
          aliases: { select: { alias: true }, take: 6, orderBy: { alias: 'asc' } },
          metrics: { select: { engagementScore: true } },
        },
        orderBy: [{ metrics: { engagementScore: 'desc' } }, { updatedAt: 'desc' }],
        take: limit,
      });
      const out = rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        label: r.label,
        kind: r.kind,
        score: r.metrics?.engagementScore ?? 0,
        aliases: r.aliases.map((a) => a.alias),
      }));
      this.setSearchCache(cacheKey, out);
      return out;
    }
    const words = q.split(' ').filter(Boolean);

    const rows = await this.prisma.taxonomyTerm.findMany({
      where: {
        status: 'active',
        OR: [
          { slug: { contains: q } },
          { label: { contains: q, mode: 'insensitive' } },
          { aliases: { some: { alias: { contains: q } } } },
          ...words.map((w) => ({
            OR: [
              { slug: { contains: w } },
              { label: { contains: w, mode: 'insensitive' as const } },
              { aliases: { some: { alias: { contains: w } } } },
            ],
          })),
        ],
      },
      include: {
        aliases: { select: { alias: true }, take: 6, orderBy: { alias: 'asc' } },
      },
      take: Math.min(limit * 3, 120),
    });

    const qLower = q.toLowerCase();
    const scored = rows.map((r) => {
      const slug = r.slug.toLowerCase();
      const label = (r.label ?? '').toLowerCase();
      const aliases = r.aliases.map((a) => a.alias.toLowerCase());
      let score = 0;
      if (slug === qLower) score = Math.max(score, 120);
      if (label === qLower) score = Math.max(score, 115);
      if (aliases.includes(qLower)) score = Math.max(score, 110);
      if (slug.startsWith(qLower)) score = Math.max(score, 100);
      if (label.startsWith(qLower)) score = Math.max(score, 95);
      if (aliases.some((a) => a.startsWith(qLower))) score = Math.max(score, 90);
      if (slug.includes(qLower) || label.includes(qLower)) score = Math.max(score, 80);
      if (words.length > 0 && words.every((w) => slug.includes(w) || label.includes(w) || aliases.some((a) => a.includes(w)))) {
        score = Math.max(score, 85);
      }
      return {
        id: r.id,
        slug: r.slug,
        label: r.label,
        kind: r.kind,
        score,
        aliases: r.aliases.map((a) => a.alias),
      } as TaxonomySearchResult;
    });

    scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
    const out = scored.slice(0, limit);
    this.setSearchCache(cacheKey, out);
    return out;
  }

  async getBySlug(slugRaw: string): Promise<TaxonomySearchResult | null> {
    const slug = slugify(slugRaw);
    if (!slug) return null;
    const row = await this.prisma.taxonomyTerm.findUnique({
      where: { slug },
      include: { aliases: { select: { alias: true }, orderBy: { alias: 'asc' } } },
    });
    if (!row || row.status !== 'active') return null;
    return {
      id: row.id,
      slug: row.slug,
      label: row.label,
      kind: row.kind,
      score: 0,
      aliases: row.aliases.map((a) => a.alias),
    };
  }

  async backfillAndSync(): Promise<{ terms: number; aliases: number; edges: number; metricsUpdated: number }> {
    // 1) Seed canonical topics + subtopics from static topic options.
    const topicRows = TOPIC_OPTIONS.map((opt) => ({
      slug: slugify(opt.value),
      label: opt.label,
      kind: 'topic' as const,
      status: 'active' as const,
      aliases: [opt.value, opt.label, ...(opt.aliases ?? [])].map((a) => normalizeInput(a)).filter(Boolean),
      group: opt.group,
    }));

    for (const t of topicRows) {
      const term = await this.prisma.taxonomyTerm.upsert({
        where: { slug: t.slug },
        update: { label: t.label, kind: t.kind, status: t.status },
        create: { slug: t.slug, label: t.label, kind: t.kind, status: t.status },
      });
      for (const alias of t.aliases) {
        await this.prisma.taxonomyAlias.upsert({
          where: { alias },
          update: { termId: term.id, source: 'topic_config' },
          create: { alias, termId: term.id, source: 'topic_config' },
        });
      }
    }

    // 2) Ingest article tags as canonical tag terms.
    const articleTags = await this.prisma.articleTag.groupBy({
      by: ['tag'],
      _count: { tag: true },
      orderBy: { _count: { tag: 'desc' } },
      take: 5000,
    });
    const tagLabelRows = await this.prisma.articleTag.groupBy({
      by: ['tag', 'label'],
      _count: { label: true },
      orderBy: [{ tag: 'asc' }, { _count: { label: 'desc' } }],
      take: 8000,
    });
    const preferredLabelByTag = new Map<string, string>();
    for (const row of tagLabelRows) {
      if (!preferredLabelByTag.has(row.tag)) preferredLabelByTag.set(row.tag, row.label);
    }
    for (const row of articleTags) {
      const slug = slugify(row.tag);
      if (!slug) continue;
      const label = (preferredLabelByTag.get(row.tag) ?? row.tag).trim();
      const term = await this.prisma.taxonomyTerm.upsert({
        where: { slug },
        update: { label, kind: 'tag', status: 'active' },
        create: { slug, label, kind: 'tag', status: 'active' },
      });
      const alias = normalizeInput(label);
      if (alias) {
        await this.prisma.taxonomyAlias.upsert({
          where: { alias },
          update: { termId: term.id, source: 'article_tag' },
          create: { alias, termId: term.id, source: 'article_tag' },
        });
      }
    }

    // 3) Link hashtags as related aliases to matching term slugs.
    const hashtags = await this.prisma.hashtag.findMany({
      orderBy: [{ usageCount: 'desc' }, { tag: 'asc' }],
      take: 3000,
      select: { tag: true },
    });
    const knownTermSlugs = new Set(
      (await this.prisma.taxonomyTerm.findMany({
        where: { status: 'active' },
        select: { slug: true },
      })).map((t) => t.slug),
    );
    for (const h of hashtags) {
      const slug = slugify(h.tag);
      if (!slug) continue;
      if (!knownTermSlugs.has(slug)) continue;
      const term = await this.prisma.taxonomyTerm.findUnique({ where: { slug }, select: { id: true } });
      if (!term) continue;
      const alias = normalizeInput(h.tag);
      if (!alias) continue;
      await this.prisma.taxonomyAlias.upsert({
        where: { alias },
        update: { termId: term.id, source: 'hashtag' },
        create: { alias, termId: term.id, source: 'hashtag' },
      });
    }

    // 4) Recompute lightweight metrics table.
    const terms = await this.prisma.taxonomyTerm.findMany({ where: { status: 'active' }, select: { id: true, slug: true } });
    const lookbackStart = new Date(Date.now() - 14 * 24 * 3600 * 1000);
    for (const term of terms) {
      const [articleCount, postCount, hashtagCount, recentArticleCount, recentPostCount] = await Promise.all([
        this.prisma.articleTag.count({ where: { tag: term.slug } }),
        this.prisma.post.count({ where: { topics: { has: term.slug }, deletedAt: null } }),
        this.prisma.hashtag.count({ where: { tag: term.slug } }),
        this.prisma.articleTag.count({
          where: { tag: term.slug, article: { publishedAt: { gte: lookbackStart }, deletedAt: null, isDraft: false } },
        }),
        this.prisma.post.count({
          where: { topics: { has: term.slug }, createdAt: { gte: lookbackStart }, deletedAt: null },
        }),
      ]);
      const recentVelocity = recentArticleCount + recentPostCount;
      const engagementScore = articleCount * 2 + postCount + hashtagCount * 0.5;
      await this.prisma.taxonomyTermMetric.upsert({
        where: { termId: term.id },
        update: { articleCount, postCount, hashtagCount, recentVelocity, engagementScore },
        create: { termId: term.id, articleCount, postCount, hashtagCount, recentVelocity, engagementScore },
      });
    }

    const [termCount, aliasCount, edgeCount, metricCount] = await Promise.all([
      this.prisma.taxonomyTerm.count(),
      this.prisma.taxonomyAlias.count(),
      this.prisma.taxonomyEdge.count(),
      this.prisma.taxonomyTermMetric.count(),
    ]);
    this.searchCache.clear();
    return { terms: termCount, aliases: aliasCount, edges: edgeCount, metricsUpdated: metricCount };
  }

  async setUserPreferences(userId: string, termIds: string[]) {
    const uniqueIds = [...new Set(termIds.map((id) => String(id ?? '').trim()).filter(Boolean))].slice(0, 30);
    const existing = await this.prisma.taxonomyTerm.count({
      where: { id: { in: uniqueIds }, status: 'active' },
    });
    if (uniqueIds.length > 0 && existing === 0) {
      throw new BadRequestException('No valid taxonomy terms provided.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userTaxonomyPreference.deleteMany({ where: { userId } });
      if (uniqueIds.length > 0) {
        await tx.userTaxonomyPreference.createMany({
          data: uniqueIds.map((termId) => ({ userId, termId })),
          skipDuplicates: true,
        });
      }
    });

    return this.getUserPreferences(userId);
  }

  async getUserPreferences(userId: string) {
    const rows = await this.prisma.userTaxonomyPreference.findMany({
      where: { userId },
      include: { term: { select: { id: true, slug: true, label: true, kind: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      termId: r.termId,
      slug: r.term.slug,
      label: r.term.label,
      kind: r.term.kind,
    }));
  }
}
