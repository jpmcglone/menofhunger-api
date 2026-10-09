import { Injectable } from "@nestjs/common";
import { PostsReadService } from "../posts-read/posts-read.service";
import { BACKFILL_MAX_POSTS, BACKFILL_MAX_URLS, BACKFILL_POST_PAGE_SIZE } from "./link-metadata.constants";
import { extractLinks } from "./link-metadata-extract";
import { LinkMetadataService } from "./link-metadata.service";
import { NOT_DELETED } from '../../common/prisma/where';

/** Scans recent post bodies for links and warms the metadata cache. */
@Injectable()
export class LinkMetadataBackfillService {
  constructor(
    private readonly postsRead: PostsReadService,
    private readonly linkMetadata: LinkMetadataService,
  ) {}

  async runBackfill(): Promise<{
    urlsFound: number;
    cached: number;
    truncated: boolean;
  }> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const seen = new Set<string>();

    let cursorCreatedAt: Date | null = null;
    let cursorId: string | null = null;
    let postsScanned = 0;
    let truncated = false;

    while (postsScanned < BACKFILL_MAX_POSTS && seen.size < BACKFILL_MAX_URLS) {
      const baseWhere = {
        ...NOT_DELETED,
        body: { not: "" },
        createdAt: { gte: since },
      } as const;

      const pageWhere =
        cursorCreatedAt && cursorId
          ? {
              ...baseWhere,
              OR: [
                { createdAt: { lt: cursorCreatedAt } },
                {
                  AND: [{ createdAt: cursorCreatedAt }, { id: { lt: cursorId } }],
                },
              ],
            }
          : baseWhere;

      const posts: Array<{ id: string; createdAt: Date; body: string }> =
        await this.postsRead.findMany({
          where: pageWhere,
          select: { id: true, createdAt: true, body: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: BACKFILL_POST_PAGE_SIZE,
        });

      if (posts.length === 0) break;

      for (const p of posts) {
        for (const url of extractLinks(p.body ?? "")) {
          seen.add(url);
          if (seen.size >= BACKFILL_MAX_URLS) {
            truncated = true;
            break;
          }
        }
        if (seen.size >= BACKFILL_MAX_URLS) break;
      }

      postsScanned += posts.length;
      const last = posts[posts.length - 1];
      if (!last) break;
      cursorCreatedAt = last.createdAt;
      cursorId = last.id;

      if (posts.length < BACKFILL_POST_PAGE_SIZE) break;
    }

    if (postsScanned >= BACKFILL_MAX_POSTS) truncated = true;

    const urls = Array.from(seen);
    const cached = await this.linkMetadata.backfillForUrls(urls);
    return { urlsFound: urls.length, cached, truncated };
  }
}
