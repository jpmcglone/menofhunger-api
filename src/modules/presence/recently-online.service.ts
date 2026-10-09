import { decodeJsonCursor, encodeJsonCursor } from '../../common/pagination/json-cursor';
import { toPage } from '../../common/pagination/page';
import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { viewerCanSeeMembers } from '../auth/auth-public-api';

const RECENTLY_ONLINE_WINDOW_MS = 60 * 60_000;

export type RecentlyOnlineCursor =
  | { section: 'recent'; tMs: number; id: string }
  | { section: 'never'; cMs: number | null; id: string | null };

function encodeCursor(params: { tMs: number; id: string }): string {
  return encodeJsonCursor(params);
}

function encodeNeverCursor(params: { cMs: number | null; id: string | null }): string {
  return encodeJsonCursor({ section: 'never', cMs: params.cMs, id: params.id });
}

/**
 * Decodes either a section-A cursor { tMs, id } (backward-compat) or a
 * section-B cursor { section: 'never', cMs, id }.
 */
export function decodeRecentlyOnlineCursor(raw: string): RecentlyOnlineCursor | null {
  const parsed = decodeJsonCursor(raw);
  if (!parsed) return null;
  if (parsed.section === 'never') {
    const cMs = typeof parsed.cMs === 'number' && Number.isFinite(parsed.cMs) ? Math.floor(parsed.cMs) : null;
    const id = typeof parsed.id === 'string' ? parsed.id.trim() || null : null;
    return { section: 'never', cMs, id };
  }
  // Section A (recent online): backward-compat format { tMs, id }
  const tMs = typeof parsed.tMs === 'number' && Number.isFinite(parsed.tMs) ? Math.floor(parsed.tMs) : null;
  const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
  if (!tMs || !id) return null;
  return { section: 'recent', tMs, id };
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
        ...NOT_BANNED_USER_WHERE,
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
          ...NOT_BANNED_USER_WHERE,
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

      const a = toPage(aItems, limit, (r) => encodeCursor({ tMs: r.lastOnlineAt!.getTime(), id: r.id }));
      const aMapped = a.items.map((r) => ({ id: r.id, lastOnlineAt: r.lastOnlineAt ? r.lastOnlineAt.toISOString() : null }));

      if (a.nextCursor) {
        nextCursor = a.nextCursor;
        pageItems = aMapped;
      } else {
        const remaining = limit - a.items.length;
        const bItems = await this.prisma.user.findMany({
          where: {
            usernameIsSet: true,
            ...NOT_BANNED_USER_WHERE,
            lastOnlineAt: null,
            ...onlineFilter,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: remaining + 1,
          select: { id: true, createdAt: true },
        });

        const b = toPage(bItems, remaining, (r) => encodeNeverCursor({ cMs: r.createdAt.getTime(), id: r.id }));
        // A full section A page leaves no room for section B: resume at the start of B.
        nextCursor = remaining === 0 && bItems.length > 0 ? encodeNeverCursor({ cMs: null, id: null }) : b.nextCursor;
        pageItems = [...aMapped, ...b.items.map((r) => ({ id: r.id, lastOnlineAt: r.createdAt.toISOString() }))];
      }
    } else {
      const { cMs, id: cId } = cursor;
      const bItems = await this.prisma.user.findMany({
        where: {
          usernameIsSet: true,
          ...NOT_BANNED_USER_WHERE,
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

      const b = toPage(bItems, limit, (r) => encodeNeverCursor({ cMs: r.createdAt.getTime(), id: r.id }));
      nextCursor = b.nextCursor;
      pageItems = b.items.map((r) => ({ id: r.id, lastOnlineAt: r.createdAt.toISOString() }));
    }

    return { items: pageItems, nextCursor };
  }
}
