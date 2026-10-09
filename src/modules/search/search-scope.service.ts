import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PostVisibility } from '@prisma/client';
import { excludeBoardOnlyWhere } from '../posts/posts-query-builders';
import { PrismaService } from '../prisma/prisma.service';
import { ViewerContextService } from '../viewer/viewer-context.service';
import type { Viewer } from './search.shared';
import { NOT_DELETED } from '../../common/prisma/where';

/** Viewer-scoped visibility predicates and the photo-note lookup shared by post and bookmark search. */
@Injectable()
export class SearchScopeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewerContext: ViewerContextService,
  ) {}

  allowedVisibilitiesForViewer(viewer: Viewer): PostVisibility[] {
    return this.viewerContext.allowedPostVisibilities(viewer);
  }

  /** Post search scope: readable groups only, and never Board-only rows (the Board has its own search). */
  readableGroupPostWhere(viewer: Viewer): Prisma.PostWhereInput {
    return { AND: [excludeBoardOnlyWhere(), this.readableGroupScopeWhere(viewer)] };
  }

  readableGroupScopeWhere(viewer: Viewer): Prisma.PostWhereInput {
    const viewerUserId = (viewer?.id ?? '').trim();
    if (!viewerUserId) return { communityGroupId: null };

    const groupAccess: Prisma.PostWhereInput[] = [];
    if (viewer?.siteAdmin) {
      groupAccess.push({ communityGroup: NOT_DELETED });
    } else {
      if (this.viewerContext.isVerified(viewer)) {
        groupAccess.push({ communityGroup: { ...NOT_DELETED, joinPolicy: 'open' } });
      }
      groupAccess.push({
        communityGroup: {
          ...NOT_DELETED,
          members: {
            some: {
              userId: viewerUserId,
              status: 'active',
            },
          },
        },
      });
    }

    return { OR: [{ communityGroupId: null }, ...groupAccess] };
  }

  readableGroupPostSql(viewer: Viewer): Prisma.Sql {
    return Prisma.sql`AND p."boardOnly" = false ${this.readableGroupScopeSql(viewer)}`;
  }

  readableGroupScopeSql(viewer: Viewer): Prisma.Sql {
    const viewerUserId = (viewer?.id ?? '').trim();
    if (!viewerUserId) return Prisma.sql`AND p."communityGroupId" IS NULL`;

    if (viewer?.siteAdmin) {
      return Prisma.sql`
        AND (
          p."communityGroupId" IS NULL
          OR EXISTS (
            SELECT 1
            FROM "CommunityGroup" cg
            WHERE cg."id" = p."communityGroupId"
              AND cg."deletedAt" IS NULL
          )
        )
      `;
    }

    const openGroupSql = this.viewerContext.isVerified(viewer)
      ? Prisma.sql`
          OR EXISTS (
            SELECT 1
            FROM "CommunityGroup" cg
            WHERE cg."id" = p."communityGroupId"
              AND cg."deletedAt" IS NULL
              AND cg."joinPolicy" = 'open'
          )
        `
      : Prisma.sql``;

    return Prisma.sql`
      AND (
        p."communityGroupId" IS NULL
        ${openGroupSql}
        OR EXISTS (
          SELECT 1
          FROM "CommunityGroup" cg
          JOIN "CommunityGroupMember" cgm ON cgm."groupId" = cg."id"
          WHERE cg."id" = p."communityGroupId"
            AND cg."deletedAt" IS NULL
            AND cgm."userId" = ${viewerUserId}
            AND cgm."status" = 'active'
        )
      )
    `;
  }

  /** Files whose Marv-written photo note contains the phrase or any word. Feeds the short-query post match. */
  async mediaNoteKeysFor(q: string, words: string[]): Promise<string[]> {
    const trimmed = (q ?? '').trim();
    if (trimmed.length < 2) return [];
    const terms = [...new Set([trimmed, ...words.filter((w) => w.length >= 2)])];
    try {
      const rows = await this.prisma.mediaSearchNote.findMany({
        where: { OR: terms.map((t) => ({ note: { contains: t, mode: 'insensitive' as const } })) },
        select: { r2Key: true },
        take: 200,
      });
      return rows.map((r) => r.r2Key);
    } catch {
      // Photo notes are a bonus; search keeps working without them.
      return [];
    }
  }
}
