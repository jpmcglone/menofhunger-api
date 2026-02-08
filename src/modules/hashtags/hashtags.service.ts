import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PostVisibility, VerifiedStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Viewer = { id: string; verifiedStatus: VerifiedStatus; premium: boolean } | null;

function parseTrendingCursor(
  cursor: string | null,
): { asOfMs: number; score: number; usageCount: number; tag: string } | null {
  const raw = (cursor ?? '').trim();
  if (!raw.startsWith('ht:')) return null;
  const parts = raw.slice(3).split('|');
  if (parts.length < 4) return null;
  const asOfMs = Number(parts[0]);
  const score = Number(parts[1]);
  const usageCount = Number(parts[2]);
  const tag = String(parts.slice(3).join('|') ?? '').trim();
  if (!Number.isFinite(asOfMs) || asOfMs <= 0) return null;
  if (!Number.isFinite(score)) return null;
  if (!Number.isFinite(usageCount)) return null;
  if (!tag) return null;
  return { asOfMs, score, usageCount, tag };
}

function makeTrendingCursor(params: { asOf: Date; score: number; usageCount: number; tag: string }) {
  const asOfMs = params.asOf.getTime();
  // Keep a stable, compact representation for floats.
  const score = Number.isFinite(params.score) ? Number(params.score.toFixed(6)) : 0;
  const usage = Math.max(0, Math.floor(Number(params.usageCount) || 0));
  const tag = String(params.tag ?? '').trim();
  return `ht:${asOfMs}|${score}|${usage}|${tag}`;
}

@Injectable()
export class HashtagsService {
  constructor(private readonly prisma: PrismaService) {}

  private async viewerById(viewerUserId: string | null): Promise<Viewer> {
    if (!viewerUserId) return null;
    return await this.prisma.user.findUnique({
      where: { id: viewerUserId },
      select: { id: true, verifiedStatus: true, premium: true },
    });
  }

  private allowedVisibilitiesForViewer(viewer: Viewer): PostVisibility[] {
    const allowed: PostVisibility[] = ['public'];
    if (viewer?.verifiedStatus && viewer.verifiedStatus !== 'none') allowed.push('verifiedOnly');
    if (viewer?.premium) allowed.push('premiumOnly');
    return allowed;
  }

  async trendingHashtags(params: {
    viewerUserId: string | null;
    limit: number;
    cursor: string | null;
  }): Promise<{ hashtags: Array<{ value: string; label: string; usageCount: number }>; nextCursor: string | null }> {
    const limit = Math.max(1, Math.min(50, params.limit || 20));
    const viewer = await this.viewerById(params.viewerUserId ?? null);
    const allowed = this.allowedVisibilitiesForViewer(viewer);

    const cursor = parseTrendingCursor(params.cursor ?? null);

    const latest = await this.prisma.hashtagTrendingScoreSnapshot.findFirst({
      orderBy: [{ asOf: 'desc' }],
      select: { asOf: true },
    });
    const asOf = latest?.asOf ?? null;
    if (!asOf) return { hashtags: [], nextCursor: null };

    // Keep pagination stable across refreshes: only accept cursor if it matches the current asOf.
    const cursorOk = cursor && cursor.asOfMs === asOf.getTime();

    const allowedSql = allowed.map((v) => Prisma.sql`${v}::"PostVisibility"`);
    const cursorSql = cursorOk
      ? Prisma.sql`WHERE (
          a."score" < ${cursor!.score}
          OR (a."score" = ${cursor!.score} AND a."usageCount" < ${cursor!.usageCount})
          OR (a."score" = ${cursor!.score} AND a."usageCount" = ${cursor!.usageCount} AND a."tag" > ${cursor!.tag})
        )`
      : Prisma.sql``;

    const rows = await this.prisma.$queryRaw<
      Array<{
        tag: string;
        score: number;
        usageCount: number;
      }>
    >(Prisma.sql`
      WITH a AS (
        SELECT
          s."tag" as "tag",
          CAST(SUM(s."score") AS DOUBLE PRECISION) as "score",
          CAST(SUM(s."usageCount") AS INT) as "usageCount"
        FROM "HashtagTrendingScoreSnapshot" s
        WHERE
          s."asOf" = ${asOf}
          AND s."visibility" IN (${Prisma.join(allowedSql)})
        GROUP BY 1
      )
      SELECT a."tag", a."score", a."usageCount"
      FROM a
      ${cursorSql}
      ORDER BY a."score" DESC, a."usageCount" DESC, a."tag" ASC
      LIMIT ${limit + 1}
    `);

    const slice = rows.slice(0, limit);
    const nextRow = rows.length > limit ? slice[slice.length - 1] : null;
    const nextCursor =
      rows.length > limit && nextRow?.tag
        ? makeTrendingCursor({ asOf, tag: nextRow.tag, score: nextRow.score, usageCount: nextRow.usageCount })
        : null;

    const tags = slice.map((r) => (r.tag ?? '').trim()).filter(Boolean);
    const labelByTag = new Map<string, string>();
    if (tags.length > 0) {
      const variantRows = await this.prisma.$queryRaw<Array<{ tag: string; variant: string }>>(Prisma.sql`
        SELECT DISTINCT ON (hv."tag")
          hv."tag" as "tag",
          hv."variant" as "variant"
        FROM "HashtagVariant" hv
        WHERE hv."tag" IN (${Prisma.join(tags.map((t) => Prisma.sql`${t}`))})
        ORDER BY hv."tag" ASC, hv."count" DESC, hv."variant" ASC
      `);
      for (const r of variantRows) {
        const t = (r?.tag ?? '').trim();
        const v = (r?.variant ?? '').trim();
        if (t && v) labelByTag.set(t, v);
      }
    }

    return {
      hashtags: slice.map((r) => ({
        value: r.tag,
        label: labelByTag.get(r.tag) ?? r.tag,
        usageCount: r.usageCount ?? 0,
      })),
      nextCursor,
    };
  }
}

