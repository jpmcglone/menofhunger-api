import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { publicAssetUrl } from '../../../common/assets/public-asset-url';
import { MarvinBotIdentityService } from './marvin-bot-identity.service';

/** Default cap on how many ancestor levels to walk up the parent chain. */
const DEFAULT_ANCESTOR_LIMIT = 15;
/** Default cap on how deep to descend into the reply subtree. */
const DEFAULT_DESCENDANT_DEPTH = 6;
/** Default cap on how many descendant posts to include in the assembled context. */
const DEFAULT_DESCENDANT_LIMIT = 40;
/** Body truncation applied to every collected post so the prompt stays bounded. */
const BODY_TRUNCATE = 500;

export type MarvThreadContextMedia = {
  kind: string;
  source: string;
  r2Key: string | null;
  url: string | null;
};

export type MarvThreadContextPoll = {
  totalVoteCount: number;
  endsAt: Date | null;
  options: Array<{ text: string; voteCount: number }>;
};

export type MarvThreadContextPost = {
  id: string;
  parentId: string | null;
  rootId: string | null;
  /** 0 = focal post, negative = ancestor (−1 is the immediate parent), positive = descendant. */
  depth: number;
  authorUserId: string;
  authorUsername: string | null;
  authorDisplayName: string | null;
  body: string;
  createdAt: Date;
  /** Last edit timestamp — `null` when never edited. Used by catch-up's freshness marker so edited posts bust the cache. */
  editedAt: Date | null;
  checkinPrompt: string | null;
  /** True when Marv himself authored the post. */
  isMarv: boolean;
  media: MarvThreadContextMedia[];
  poll: MarvThreadContextPoll | null;
};

export type MarvThreadContext = {
  /** The post the context was collected around. Null when it could not be loaded. */
  focal: MarvThreadContextPost | null;
  /** Path above the focal post, ordered root-most → immediate parent. */
  ancestors: MarvThreadContextPost[];
  /** Replies under the focal post, in depth-first reading order, capped at the limit. */
  descendants: MarvThreadContextPost[];
  /** Number of descendants discovered within the traversal depth (may exceed `descendants.length`). */
  totalDescendants: number;
  /** Thread root id (the focal post's own id when it is a root). */
  rootId: string | null;
};

/**
 * Collects the conversation surrounding a focal post in BOTH directions:
 *  - the ancestor chain above it (verbatim path the focal post is replying within), and
 *  - the reply subtree below it (a depth- and count-capped tree walk).
 *
 * Powers both the user-facing "Catch me up" summary and the @marv mention reply
 * (so Marv reasons about what's above AND below the message that mentioned him,
 * not just the flat recent-replies list it used before).
 *
 * Strategy mirrors `PostsFeedQueryService.collectParentMapForFeed`: cheap recursive
 * CTEs resolve the ids (one round-trip each), then a single batched Prisma `findMany`
 * loads the full rows (author, media, poll) so we get Prisma's typed selects.
 *
 * Visibility: soft-deleted and `onlyMe` posts are filtered at the SQL layer. Callers
 * that need per-viewer access control on the focal post itself must resolve it through
 * `PostsService.getById` first — this service only excludes the universally-private rows.
 */
@Injectable()
export class MarvinThreadContextService {
  private readonly logger = new Logger(MarvinThreadContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: MarvinBotIdentityService,
  ) {}

  async collect(params: {
    focalPostId: string;
    ancestorLimit?: number;
    descendantDepth?: number;
    descendantLimit?: number;
  }): Promise<MarvThreadContext> {
    const focalPostId = (params.focalPostId ?? '').trim();
    const empty: MarvThreadContext = {
      focal: null,
      ancestors: [],
      descendants: [],
      totalDescendants: 0,
      rootId: null,
    };
    if (!focalPostId) return empty;

    const ancestorLimit = params.ancestorLimit ?? DEFAULT_ANCESTOR_LIMIT;
    const descendantDepth = params.descendantDepth ?? DEFAULT_DESCENDANT_DEPTH;
    const descendantLimit = params.descendantLimit ?? DEFAULT_DESCENDANT_LIMIT;

    // Resolve ancestor/descendant ids with independent, fault-isolated queries: a failure
    // in one walk must never drop the focal post (which is always fetched below). This is
    // what makes "Catch me up" work even on a lone post with no thread around it.
    const ancestorRows = await this.collectAncestorIds(focalPostId, ancestorLimit);
    const descendantRows = await this.collectDescendantIds(focalPostId, descendantDepth);

    try {
      const includedDescendantRows = descendantRows.slice(0, descendantLimit);

      const ids = [
        focalPostId,
        ...ancestorRows.map((r) => r.id),
        ...includedDescendantRows.map((r) => r.id),
      ];

      const [marvUserId, rows] = await Promise.all([
        this.identity.getMarvUserId(),
        this.prisma.post.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            parentId: true,
            rootId: true,
            body: true,
            createdAt: true,
            editedAt: true,
            checkinPrompt: true,
            userId: true,
            user: { select: { username: true, name: true } },
            media: {
              where: { kind: { not: 'video' } },
              select: { kind: true, source: true, r2Key: true, url: true, position: true },
              orderBy: { position: 'asc' },
            },
            poll: {
              select: {
                totalVoteCount: true,
                endsAt: true,
                options: { select: { text: true, voteCount: true }, orderBy: { position: 'asc' } },
              },
            },
          },
        }),
      ]);

      type Row = (typeof rows)[number];
      const byId = new Map<string, Row>(rows.map((r) => [r.id, r]));

      const toPost = (row: Row, depth: number): MarvThreadContextPost => ({
        id: row.id,
        parentId: row.parentId,
        rootId: row.rootId,
        depth,
        authorUserId: row.userId,
        authorUsername: row.user.username,
        authorDisplayName: row.user.name,
        body: (row.body ?? '').slice(0, BODY_TRUNCATE),
        createdAt: row.createdAt,
        editedAt: row.editedAt,
        checkinPrompt: row.checkinPrompt,
        isMarv: marvUserId !== null && row.userId === marvUserId,
        media: (row.media ?? []).map((m) => ({
          kind: m.kind,
          source: m.source,
          r2Key: m.r2Key,
          url: m.url,
        })),
        poll: row.poll
          ? {
              totalVoteCount: row.poll.totalVoteCount,
              endsAt: row.poll.endsAt,
              options: row.poll.options.map((o) => ({ text: o.text, voteCount: o.voteCount })),
            }
          : null,
      });

      const focalRow = byId.get(focalPostId);
      const focal = focalRow ? toPost(focalRow, 0) : null;

      const ancestors: MarvThreadContextPost[] = [];
      ancestorRows.forEach((r, idx) => {
        const row = byId.get(r.id);
        if (row) ancestors.push(toPost(row, -(ancestorRows.length - idx)));
      });

      const descendants: MarvThreadContextPost[] = [];
      for (const r of includedDescendantRows) {
        const row = byId.get(r.id);
        if (row) descendants.push(toPost(row, r.depth));
      }

      return {
        focal,
        ancestors,
        descendants,
        totalDescendants: descendantRows.length,
        rootId: focal?.rootId ?? focal?.id ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `[marv] thread-context collect failed for focal=${focalPostId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return empty;
    }
  }

  /**
   * Select image URLs from across a collected conversation, resolving uploads against the public
   * CDN base and keeping giphy/external URLs as-is. Videos are already excluded by `collect`.
   * Includes EVERY image — multiple per post and throughout the thread — deduped by URL, up to
   * `visionMaxImagesPerTurn` (raise `MARV_VISION_MAX_IMAGES_PER_TURN` to include more). Shared by
   * "Catch me up" and the @marv reply path so both surfaces see the same media and bill identically.
   *
   * Selection strategy when the cap binds: choose by PROXIMITY to the focal post (its own images
   * first — they're the thing the user clicked — then the immediate parent/replies, expanding
   * outward; reading order breaks ties). This beats a flat top-down slice, which could exhaust the
   * budget on image-heavy ancestors and starve the focal post. The chosen set is then re-sorted
   * back into READING ORDER for presentation, so it still lines up with the per-post `[attached: …]`
   * markers in the prompt.
   *
   * `totalImages` is the count discovered before the cap, so callers can log/surface drops.
   */
  selectImageMedia(
    context: MarvThreadContext,
    opts: { visionEnabled: boolean; visionMaxImagesPerTurn: number; publicBaseUrl: string | null },
  ): { imageUrls: string[]; hasGifAttached: boolean; totalImages: number } {
    if (!opts.visionEnabled) return { imageUrls: [], hasGifAttached: false, totalImages: 0 };
    const orderedPosts: MarvThreadContextPost[] = [
      ...context.ancestors,
      ...(context.focal ? [context.focal] : []),
      ...context.descendants,
    ];

    const seen = new Set<string>();
    type Candidate = { url: string; kind: string; distance: number; readingIndex: number };
    const candidates: Candidate[] = [];
    let readingIndex = 0;
    for (const p of orderedPosts) {
      for (const m of p.media ?? []) {
        const url =
          m.source === 'upload' && m.r2Key
            ? publicAssetUrl({ publicBaseUrl: opts.publicBaseUrl, key: m.r2Key })
            : (m.url ?? null);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        // `depth` is 0 at the focal post, negative for ancestors, positive for descendants —
        // its magnitude is exactly the proximity we want (parent and immediate reply both = 1).
        candidates.push({ url, kind: m.kind, distance: Math.abs(p.depth), readingIndex: readingIndex++ });
      }
    }
    if (candidates.length === 0) return { imageUrls: [], hasGifAttached: false, totalImages: 0 };

    const max = Math.max(0, opts.visionMaxImagesPerTurn);
    const chosen = [...candidates]
      .sort((a, b) => a.distance - b.distance || a.readingIndex - b.readingIndex)
      .slice(0, max)
      .sort((a, b) => a.readingIndex - b.readingIndex);
    return {
      imageUrls: chosen.map((e) => e.url),
      hasGifAttached: chosen.some((e) => e.kind === 'gif'),
      totalImages: candidates.length,
    };
  }

  /** Ancestors: walk up `parentId` from the focal post. Ordered root-most → parent. */
  private async collectAncestorIds(
    focalPostId: string,
    ancestorLimit: number,
  ): Promise<Array<{ id: string; depth: number }>> {
    try {
      return await this.prisma.$queryRawUnsafe<Array<{ id: string; depth: number }>>(
        `
        WITH RECURSIVE ancestors AS (
          SELECT id, "parentId", 0 AS depth FROM "Post" WHERE id = $1
          UNION ALL
          SELECT p.id, p."parentId", a.depth + 1
          FROM "Post" p
          INNER JOIN ancestors a ON a."parentId" = p.id
          WHERE p."deletedAt" IS NULL AND p."visibility"::text <> 'onlyMe' AND a.depth < $2
        )
        SELECT id, depth FROM ancestors WHERE depth > 0 ORDER BY depth DESC
        `,
        focalPostId,
        ancestorLimit,
      );
    } catch (err) {
      this.logger.warn(
        `[marv] thread-context ancestors failed for focal=${focalPostId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Descendants: walk down from the focal post. `ord` is a createdAt path so a parent
   * always sorts immediately before its own subtree (depth-first preorder reading order).
   *
   * The `::timestamp` casts are load-bearing: the `Post."createdAt"` column is
   * `timestamp(3)`, and a recursive CTE requires the non-recursive and recursive terms to
   * share an EXACT column type — without the cast Postgres rejects the query with
   * "type timestamp(3)[] in non-recursive term but type timestamp[] overall".
   */
  private async collectDescendantIds(
    focalPostId: string,
    descendantDepth: number,
  ): Promise<Array<{ id: string; depth: number }>> {
    try {
      return await this.prisma.$queryRawUnsafe<Array<{ id: string; depth: number }>>(
        `
        WITH RECURSIVE descendants AS (
          SELECT id, "parentId", "createdAt", 1 AS depth, ARRAY["createdAt"::timestamp] AS ord
          FROM "Post"
          WHERE "parentId" = $1 AND "deletedAt" IS NULL AND "visibility"::text <> 'onlyMe'
          UNION ALL
          SELECT p.id, p."parentId", p."createdAt", d.depth + 1, d.ord || p."createdAt"::timestamp
          FROM "Post" p
          INNER JOIN descendants d ON p."parentId" = d.id
          WHERE p."deletedAt" IS NULL AND p."visibility"::text <> 'onlyMe' AND d.depth < $2
        )
        SELECT id, depth FROM descendants ORDER BY ord
        `,
        focalPostId,
        descendantDepth,
      );
    } catch (err) {
      this.logger.warn(
        `[marv] thread-context descendants failed for focal=${focalPostId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }
}
