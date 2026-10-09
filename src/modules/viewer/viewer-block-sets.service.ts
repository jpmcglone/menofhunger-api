import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { RedisKeys } from "../redis/redis-keys";

export type ViewerBlockSets = {
  blockedByViewer: Set<string>;
  viewerBlockedBy: Set<string>;
};
type CachedBlockSets = { blockedByViewer: string[]; viewerBlockedBy: string[] };

/** Shared block relationship projection for feeds, Board and embedded post DTOs. */
@Injectable()
export class ViewerBlockSetsService {
  private static readonly ttlSeconds = 5 * 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async get(viewerUserId: string): Promise<ViewerBlockSets> {
    if (!viewerUserId)
      return { blockedByViewer: new Set(), viewerBlockedBy: new Set() };
    const key = RedisKeys.viewerBlockSets(viewerUserId);
    try {
      const cached = await this.redis.getJson<CachedBlockSets>(key);
      if (
        cached &&
        this.validIds(cached.blockedByViewer) &&
        this.validIds(cached.viewerBlockedBy)
      ) {
        return {
          blockedByViewer: new Set(cached.blockedByViewer),
          viewerBlockedBy: new Set(cached.viewerBlockedBy),
        };
      }
    } catch {
      // Cache availability never determines whether the database can answer this read.
    }
    const rows = await this.prisma.userBlock.findMany({
      where: { OR: [{ blockerId: viewerUserId }, { blockedId: viewerUserId }] },
      select: { blockerId: true, blockedId: true },
    });
    const blockedByViewer = new Set<string>();
    const viewerBlockedBy = new Set<string>();
    for (const row of rows) {
      if (row.blockerId === viewerUserId) blockedByViewer.add(row.blockedId);
      if (row.blockedId === viewerUserId) viewerBlockedBy.add(row.blockerId);
    }
    try {
      await this.redis.setJson(
        key,
        {
          blockedByViewer: [...blockedByViewer],
          viewerBlockedBy: [...viewerBlockedBy],
        },
        { ttlSeconds: ViewerBlockSetsService.ttlSeconds },
      );
    } catch {
      // Return the authoritative database result even when caching fails.
    }
    return { blockedByViewer, viewerBlockedBy };
  }

  /** Await after a successful mutation, before publishing its cross-device refresh. */
  async invalidate(...userIds: string[]): Promise<void> {
    const keys = [...new Set(userIds.filter(Boolean))].map(
      RedisKeys.viewerBlockSets,
    );
    if (!keys.length) return;
    try {
      await this.redis.del(...keys);
    } catch {
      /* Existing entries still expire. */
    }
  }

  private validIds(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((id) => typeof id === "string");
  }
}
