import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MarvinBotIdentityService } from './marvin-bot-identity.service';
import { resolveMarvVisionUrl } from './marvin-vision-media';
import { windowThreadAroundFocal } from './marvin-thread-window';

/** Safety cap so a mega-thread cannot blow the prompt. Typical MOH threads fit entirely. */
const DEFAULT_THREAD_LIMIT = 80;
/** Match the premium post body max so we do not clip what members actually wrote. */
const BODY_TRUNCATE = 1000;

export type MarvThreadContextMedia = {
  kind: string;
  source: string;
  r2Key: string | null;
  url: string | null;
  thumbnailR2Key: string | null;
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

export type MarvGroupVenue = {
  name: string;
  description: string | null;
  rules: string | null;
  joinPolicy: 'open' | 'approval';
  memberCount: number;
};

export type MarvThreadContext = {
  /** The post the context was collected around. Null when it could not be loaded. */
  focal: MarvThreadContextPost | null;
  /** Posts before the focal post in thread reading order (siblings included). */
  ancestors: MarvThreadContextPost[];
  /** Posts after the focal post in thread reading order (siblings included). */
  descendants: MarvThreadContextPost[];
  /** Public replies in the whole thread (may exceed the windowed `descendants.length`). */
  totalDescendants: number;
  /** Thread root id (the focal post's own id when it is a root). */
  rootId: string | null;
  /** Community group this thread lives in, when the focal post is in a group. */
  group: MarvGroupVenue | null;
};

/**
 * Collects the full public conversation for a focal post — every non-deleted,
 * non-onlyMe post that shares its thread root — then splits it into posts
 * before the focal (ancestors) and after it (descendants) in reading order.
 *
 * Powers both "Catch me up" and @marv replies so Marv sees sibling branches,
 * not just the parent path + subtree under the clicked post.
 *
 * Threads larger than {@link DEFAULT_THREAD_LIMIT} are windowed around the focal
 * post (history before it, then later replies) with the root pinned in. The
 * rolling thread summary covers anything that still falls off.
 *
 * Visibility: soft-deleted and `onlyMe` posts are filtered here. Callers that
 * need per-viewer access control on the focal post must resolve it through
 * `PostsService.getById` first.
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
    threadLimit?: number;
  }): Promise<MarvThreadContext> {
    const focalPostId = (params.focalPostId ?? '').trim();
    const empty: MarvThreadContext = {
      focal: null,
      ancestors: [],
      descendants: [],
      totalDescendants: 0,
      rootId: null,
      group: null,
    };
    if (!focalPostId) return empty;

    const threadLimit = params.threadLimit ?? DEFAULT_THREAD_LIMIT;

    try {
      const focalMeta = await this.prisma.post.findFirst({
        where: { id: focalPostId, deletedAt: null },
        select: { id: true, rootId: true },
      });
      if (!focalMeta) return empty;
      const rootId = focalMeta.rootId ?? focalMeta.id;
      const threadWhere = {
        OR: [{ id: rootId }, { rootId }],
        deletedAt: null,
        visibility: { not: 'onlyMe' as const },
      };

      const [marvUserId, totalInThread, rows] = await Promise.all([
        this.identity.getMarvUserId(),
        this.prisma.post.count({ where: threadWhere }),
        this.prisma.post.findMany({
          where: threadWhere,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            parentId: true,
            rootId: true,
            body: true,
            createdAt: true,
            editedAt: true,
            checkinPrompt: true,
            userId: true,
            communityGroupId: true,
            communityGroup: {
              select: {
                name: true,
                description: true,
                rules: true,
                joinPolicy: true,
                memberCount: true,
                deletedAt: true,
              },
            },
            user: { select: { username: true, name: true } },
            media: {
              where: { deletedAt: null },
              select: {
                kind: true,
                source: true,
                r2Key: true,
                url: true,
                thumbnailR2Key: true,
                position: true,
              },
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
      const included = windowThreadAroundFocal(rows, focalPostId, threadLimit, rootId);
      const byId = new Map<string, Row>(included.map((r) => [r.id, r]));

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
          thumbnailR2Key: m.thumbnailR2Key,
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
      const groupRow = focalRow?.communityGroup;
      const group: MarvGroupVenue | null =
        groupRow && !groupRow.deletedAt
          ? {
              name: groupRow.name,
              description: groupRow.description ?? null,
              rules: groupRow.rules ?? null,
              joinPolicy: groupRow.joinPolicy,
              memberCount: groupRow.memberCount,
            }
          : null;

      const focalIndex = included.findIndex((r) => r.id === focalPostId);
      const before = focalIndex >= 0 ? included.slice(0, focalIndex) : included;
      const after = focalIndex >= 0 ? included.slice(focalIndex + 1) : [];

      const ancestors = before.map((row, idx) => toPost(row, -(before.length - idx)));
      const descendants = after.map((row, idx) => toPost(row, idx + 1));

      return {
        focal,
        ancestors,
        descendants,
        // Whole-thread reply count (not just the subtree under the focal post) so
        // Catch me up freshness sees sibling replies too.
        totalDescendants: Math.max(0, totalInThread - 1),
        rootId,
        group,
      };
    } catch (err) {
      this.logger.warn(
        `[marv] thread-context collect failed for focal=${focalPostId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return empty;
    }
  }

  /**
   * Select vision URLs from across a collected conversation, resolving uploads against the public
   * CDN base and keeping giphy/external URLs as-is. Videos contribute their poster thumbnail.
   * Includes EVERY image/GIF/poster — multiple per post and throughout the thread — deduped by URL, up to
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
        const url = resolveMarvVisionUrl(m, opts.publicBaseUrl);
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
}
