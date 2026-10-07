import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { viewerCanSeeMembers } from '../auth/member-visibility';

const RECENTLY_ONLINE_WINDOW_MS = 60 * 60_000;

export type RecentlyOnlineCursor =
  | { section: 'recent'; tMs: number; id: string }
  | { section: 'never'; cMs: number | null; id: string | null };

function encodeCursor(params: { tMs: number; id: string }): string {
  return Buffer.from(JSON.stringify(params), 'utf8').toString('base64url');
}

function encodeNeverCursor(params: { cMs: number; id: string }): string {
  return Buffer.from(JSON.stringify({ section: 'never', cMs: params.cMs, id: params.id }), 'utf8').toString('base64url');
}

/**
 * Decodes either a section-A cursor { tMs, id } (backward-compat) or a
 * section-B cursor { section: 'never', cMs, id }.
 */
export function decodeRecentlyOnlineCursor(raw: string): RecentlyOnlineCursor | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  try {
    const json = Buffer.from(s, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed?.section === 'never') {
      const cMs = typeof parsed.cMs === 'number' && Number.isFinite(parsed.cMs) ? Math.floor(parsed.cMs) : null;
      const id = typeof parsed.id === 'string' ? parsed.id.trim() || null : null;
      return { section: 'never', cMs, id };
    }
    // Section A (recent online): backward-compat format { tMs, id }
    const tMs = typeof parsed?.tMs === 'number' && Number.isFinite(parsed.tMs) ? Math.floor(parsed.tMs) : null;
    const id = typeof parsed?.id === 'string' ? parsed.id.trim() : '';
    if (!tMs || !id) return null;
    return { section: 'recent', tMs, id };
  } catch {
    return null;
  }
}

/** User reads behind "Recently online": member visibility, counts, and the two-section cursor page. */
@Injectable()
export class RecentlyOnlineService {
  constructor(private readonly prisma: PrismaService) {}

  viewerCanSeeMembers(viewerUserId: string | null | undefined): Promise<boolean> {
    return viewerCanSeeMembers(this.prisma, viewerUserId);
  }

  /** Active within the last hour but not in `excludeIds` (the currently-online roster). */
  countRecentlyOnline(excludeIds: string[]): Promise<number> {
    return this.prisma.user.count({
      where: {
        usernameIsSet: true,
        bannedAt: null,
        lastOnlineAt: { gte: new Date(Date.now() - RECENTLY_ONLINE_WINDOW_MS) },
        ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
      },
    });
  }

  /**
   * Section A: users with a known lastOnlineAt, newest first. When it runs out, section B fills
   * the page with users who have no presence history, using account creation as "last seen".
   */
  async page(params: {
    excludeIds: string[];
    limit: number;
    cursor: RecentlyOnlineCursor | null;
  }): Promise<{ items: Array<{ id: string; lastOnlineAt: string | null }>; nextCursor: string | null }> {
    const { limit, cursor } = params;
    const onlineFilter = params.excludeIds.length ? { id: { notIn: params.excludeIds } } : {};
    let pageItems: Array<{ id: string; lastOnlineAt: string | null }> = [];
    let nextCursor: string | null = null;

    if (cursor?.section !== 'never') {
      const aItems = await this.prisma.user.findMany({
        where: {
          usernameIsSet: true,
          bannedAt: null,
          lastOnlineAt: { not: null },
          ...onlineFilter,
          ...(cursor
            ? {
                OR: [
                  { lastOnlineAt: { lt: new Date(cursor.tMs) } },
                  { lastOnlineAt: new Date(cursor.tMs), id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ lastOnlineAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: { id: true, lastOnlineAt: true },
      });

      const aHasMore = aItems.length > limit;
      const aPage = aItems.slice(0, limit);

      if (aHasMore) {
        const aNext = aItems[limit];
        nextCursor = encodeCursor({ tMs: aNext.lastOnlineAt!.getTime(), id: aNext.id });
        pageItems = aPage.map((r) => ({ id: r.id, lastOnlineAt: r.lastOnlineAt ? r.lastOnlineAt.toISOString() : null }));
      } else {
        const remaining = limit - aPage.length;
        const bItems = await this.prisma.user.findMany({
          where: {
            usernameIsSet: true,
            bannedAt: null,
            lastOnlineAt: null,
            ...onlineFilter,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: remaining + 1,
          select: { id: true, createdAt: true },
        });

        const bHasMore = bItems.length > remaining;
        const bPage = bItems.slice(0, remaining);

        if (bHasMore) {
          const bNext = bItems[remaining];
          nextCursor = encodeNeverCursor({ cMs: bNext.createdAt.getTime(), id: bNext.id });
        }

        pageItems = [
          ...aPage.map((r) => ({ id: r.id, lastOnlineAt: r.lastOnlineAt ? r.lastOnlineAt.toISOString() : null })),
          ...bPage.map((r) => ({ id: r.id, lastOnlineAt: r.createdAt.toISOString() })),
        ];
      }
    } else {
      const { cMs, id: cId } = cursor;
      const bItems = await this.prisma.user.findMany({
        where: {
          usernameIsSet: true,
          bannedAt: null,
          lastOnlineAt: null,
          ...onlineFilter,
          ...(cMs != null && cId != null
            ? {
                OR: [
                  { createdAt: { lt: new Date(cMs) } },
                  { createdAt: new Date(cMs), id: { lt: cId } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: { id: true, createdAt: true },
      });

      const bHasMore = bItems.length > limit;
      const bPage = bItems.slice(0, limit);

      if (bHasMore) {
        const bNext = bItems[limit];
        nextCursor = encodeNeverCursor({ cMs: bNext.createdAt.getTime(), id: bNext.id });
      }

      pageItems = bPage.map((r) => ({ id: r.id, lastOnlineAt: r.createdAt.toISOString() }));
    }

    return { items: pageItems, nextCursor };
  }
}
