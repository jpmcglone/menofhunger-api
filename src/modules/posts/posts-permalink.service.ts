import { Inject } from '@nestjs/common';
import { PostsFeedComposeService } from './posts-feed-compose.service';
import { PostsFeedLookupService } from './posts-feed-lookup.service';
import { PostsViewerEnrichmentService } from './posts-viewer-enrichment.service';
import { PostsFeedListingsService } from './posts-feed-listings.service';
import { PostsRankingService } from './posts-ranking.service';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';

import type { Response } from 'express';
import { setReadCache } from '../../common/http-cache';
import { toPostDto } from './post.dto';
import type { CommunityGroupPreviewDto } from '../../common/dto/community-group.dto';

@Injectable()
export class PostPermalinkService {
  constructor(
    private readonly appConfig: AppConfigService,
    @Inject(PostsFeedComposeService) private readonly postsCompose: Pick<PostsFeedComposeService, 'collectAncestorPostIds' | 'getByIds' | 'communityGroupPreviewMapForFeed' | 'videoEmbedsForPosts'>,
    @Inject(PostsFeedLookupService) private readonly postsLookup: Pick<PostsFeedLookupService, 'getByIdNoAccess' | 'getById'>,
    @Inject(PostsViewerEnrichmentService) private readonly postsEnrichment: Pick<PostsViewerEnrichmentService, 'viewerContext' | 'viewerBoostedPostIds' | 'viewerBookmarksByPostId' | 'viewerVotedPollOptionIdByPostId' | 'viewerRepostedPostIds' | 'viewerLastSeenAtByPostId' | 'viewerCommentedPostIds'>,
    @Inject(PostsFeedListingsService) private readonly postsListings: Pick<PostsFeedListingsService, 'communityGroupPreviewForGroup'>,
    @Inject(PostsRankingService) private readonly postsRanking: Pick<PostsRankingService, 'ensureBoostScoresFresh' | 'computeScoresForPostIds'>,
  ) {}

  async loadPermalinkRelatedPosts(params: {
    viewerUserId: string | null;
    viewerHasAdmin: boolean;
    leaf: Awaited<ReturnType<PostsFeedLookupService['getById']>>;
    leafGated: boolean;
  }): Promise<{
    chain: Array<Awaited<ReturnType<PostsFeedLookupService['getById']>>>;
    gatedChainIndices: Set<number>;
    byId: Map<string, Awaited<ReturnType<PostsFeedLookupService['getById']>>>;
    repostedPostRaw: Awaited<ReturnType<PostsFeedLookupService['getById']>> | null;
  }> {
    const { viewerUserId, viewerHasAdmin, leaf, leafGated } = params;
    const leafParentId = (leaf as { parentId?: string | null }).parentId ?? null;
    const leafRepostedId = (leaf as { repostedPostId?: string | null }).repostedPostId ?? null;

    const ancestorIds = await this.postsCompose.collectAncestorPostIds([leafParentId, leafRepostedId]);
    const fetched = ancestorIds.length
      ? await this.postsCompose.getByIds({ viewerUserId, ids: ancestorIds })
      : [];

    const byId = new Map<string, Awaited<ReturnType<PostsFeedLookupService['getById']>>>();
    for (const row of fetched) {
      const deletedAt = (row as { deletedAt?: Date | null }).deletedAt ?? null;
      if (deletedAt && !viewerHasAdmin) continue;
      byId.set(row.id, row);
    }

    const missingIds = ancestorIds.filter((id) => !byId.has(id));
    const gatedIds = new Set<string>();
    if (missingIds.length > 0) {
      const gatedRows = await Promise.all(
        missingIds.map((id) => this.postsLookup.getByIdNoAccess(id).catch(() => null)),
      );
      for (const row of gatedRows) {
        if (!row) continue;
        byId.set(row.id, row);
        gatedIds.add(row.id);
      }
    }

    const chain: Array<Awaited<ReturnType<PostsFeedLookupService['getById']>>> = [leaf];
    const gatedChainIndices = new Set<number>();
    if (leafGated) gatedChainIndices.add(0);

    let current = leaf;
    while (current) {
      const parentId = (current as { parentId?: string | null }).parentId ?? null;
      if (!parentId) break;
      const next = byId.get(parentId);
      if (!next) break;
      chain.push(next);
      if (gatedIds.has(next.id)) {
        gatedChainIndices.add(chain.length - 1);
        break;
      }
      current = next;
    }

    const quotedSeeds = [
      ...chain,
      ...(leafRepostedId && byId.has(leafRepostedId) ? [byId.get(leafRepostedId)!] : []),
    ];
    const quotedPostIds = [
      ...new Set(
        quotedSeeds
          .map((p) => (p as { quotedPostId?: string | null }).quotedPostId)
          .filter((id): id is string => Boolean(id)),
      ),
    ].filter((id) => !byId.has(id));
    if (quotedPostIds.length > 0) {
      const quoted = await this.postsCompose.getByIds({ viewerUserId, ids: quotedPostIds });
      for (const row of quoted) byId.set(row.id, row);
      const stillMissing = quotedPostIds.filter((id) => !byId.has(id));
      if (stillMissing.length > 0) {
        const gatedQuoted = await Promise.all(
          stillMissing.map((id) => this.postsLookup.getByIdNoAccess(id).catch(() => null)),
        );
        for (const row of gatedQuoted) {
          if (row) byId.set(row.id, row);
        }
      }
    }

    return {
      chain,
      gatedChainIndices,
      byId,
      repostedPostRaw: leafRepostedId ? byId.get(leafRepostedId) ?? null : null,
    };
  }

  async getPostById(userId: string | undefined,
    id: string,
    httpRes: Response,
  ) {
    const viewerUserId = userId ?? null;

    // Try to fetch the post with normal access rules; if forbidden (tier too low),
    // fall back to a stripped preview so /p/:id can still render the gated treatment.
    let viewerCanAccess = true;
    let post: Awaited<ReturnType<typeof this.postsLookup.getById>>;
    try {
      post = await this.postsLookup.getById({ viewerUserId, id });
    } catch (e) {
      if (e instanceof ForbiddenException) {
        post = await this.postsLookup.getByIdNoAccess(id);
        viewerCanAccess = false;
      } else {
        throw e;
      }
    }

    const gatedGroupId =
      !viewerCanAccess && (post as { communityGroupId?: string | null }).communityGroupId
        ? String((post as { communityGroupId?: string | null }).communityGroupId)
        : null;
    const [viewer, groupPreview] = await Promise.all([
      this.postsEnrichment.viewerContext(viewerUserId),
      gatedGroupId
        ? this.postsListings.communityGroupPreviewForGroup(gatedGroupId, viewerUserId)
        : Promise.resolve(null),
    ]);
    const viewerHasAdmin = Boolean(viewer?.siteAdmin);

    const { chain, gatedChainIndices, byId, repostedPostRaw } = await this.loadPermalinkRelatedPosts({
      viewerUserId,
      viewerHasAdmin,
      leaf: post,
      leafGated: !viewerCanAccess,
    });

    // Build groupPreview map for any group post in the chain (including reposted) so the
    // permalink page can show the group context (back-strip, inline pill, nav highlight)
    // even when the viewer can access the post. Mirrors feed-list behavior.
    const allChainPostsForGroups: Awaited<ReturnType<typeof this.postsLookup.getById>>[] = [
      ...chain,
      ...(repostedPostRaw ? [repostedPostRaw] : []),
    ];
    const groupIdsForPreview = Array.from(
      new Set(
        allChainPostsForGroups
          .map((p) => String((p as { communityGroupId?: string | null }).communityGroupId ?? '').trim())
          .filter((gid): gid is string => Boolean(gid)),
      ),
    );
    const allPosts = [...chain, ...(repostedPostRaw ? [repostedPostRaw] : [])];
    const postIds = allPosts.map((p) => p.id);

    // Quoted posts were batched with the ancestor chain (getByIds + gated fallback).
    const quotedPostIds = Array.from(
      new Set(
        allPosts
          .map((p) => (p as { quotedPostId?: string | null }).quotedPostId)
          .filter((qid): qid is string => Boolean(qid)),
      ),
    );
    const quotedPostByIdPermalink = new Map<string, Awaited<ReturnType<typeof this.postsLookup.getById>>>();
    for (const qid of quotedPostIds) {
      const qp = byId.get(qid);
      if (qp) quotedPostByIdPermalink.set(qid, qp);
    }
    const [
      groupPreviewById,
      boosted,
      bookmarksByPostId,
      votedPollOptionIdByPostId,
      repostedByPostId,
      lastSeenAtByPostId,
      internalByPostId,
      scoreByPostIdGet,
      commentedByPostId,
    ] = await Promise.all([
      groupIdsForPreview.length
        ? this.postsCompose.communityGroupPreviewMapForFeed(viewerUserId, groupIdsForPreview)
        : Promise.resolve(new Map<string, CommunityGroupPreviewDto>()),
      viewerUserId
        ? this.postsEnrichment.viewerBoostedPostIds({ viewerUserId, postIds })
        : Promise.resolve(new Set<string>()),
      viewerUserId
        ? this.postsEnrichment.viewerBookmarksByPostId({ viewerUserId, postIds })
        : Promise.resolve(new Map<string, { collectionIds: string[] }>()),
      viewerUserId
        ? this.postsEnrichment.viewerVotedPollOptionIdByPostId({ viewerUserId, postIds })
        : Promise.resolve(new Map<string, string>()),
      viewerUserId
        ? this.postsEnrichment.viewerRepostedPostIds({ viewerUserId, postIds })
        : Promise.resolve(new Set<string>()),
      viewerUserId
        ? this.postsEnrichment.viewerLastSeenAtByPostId({ viewerUserId, postIds })
        : Promise.resolve(new Map<string, Date>()),
      viewerHasAdmin ? this.postsRanking.ensureBoostScoresFresh(postIds) : Promise.resolve(null),
      viewerHasAdmin ? this.postsRanking.computeScoresForPostIds(postIds) : Promise.resolve(undefined),
      viewerUserId
        ? this.postsEnrichment.viewerCommentedPostIds({ viewerUserId, postIds })
        : Promise.resolve(new Set<string>()),
    ]);
    const viewedByPostId = new Set(lastSeenAtByPostId.keys());
    const videoEmbedByPostId = await this.postsCompose.videoEmbedsForPosts([
      ...allPosts,
      ...quotedPostByIdPermalink.values(),
    ]);

    const r2 = this.appConfig.r2()?.publicBaseUrl ?? null;
    const toDto = (
      p: (typeof chain)[number],
      opts: {
        parent?: ReturnType<typeof toPostDto>;
        repostedPost?: ReturnType<typeof toPostDto>;
        isGatedRoot?: boolean;
        groupPreview?: Awaited<ReturnType<PostsFeedListingsService['communityGroupPreviewForGroup']>>;
      },
    ) => {
      const base = internalByPostId?.get(p.id);
      const score = scoreByPostIdGet?.get(p.id);
      const pWithPoll = p as { user?: { id?: string }; poll?: { creatorSkippedAt?: Date | null } };
      const viewerCreatorSkipped =
        Boolean(viewerUserId) &&
        pWithPoll.user?.id === viewerUserId &&
        Boolean(pWithPoll.poll?.creatorSkippedAt);
      // Prefer the gated-root preview (existing behavior) but fall back to per-post
      // group preview so accessible group posts also surface their group context.
      const ownGroupId = String((p as { communityGroupId?: string | null }).communityGroupId ?? '').trim();
      const ownGroupPreview = ownGroupId ? groupPreviewById.get(ownGroupId) ?? null : null;
      const resolvedGroupPreview = opts.isGatedRoot
        ? opts.groupPreview ?? null
        : ownGroupPreview ?? undefined;
      const quotedPostIdVal = p.quotedPostId as string | null | undefined;
      const quotedPostFromMap = quotedPostIdVal ? quotedPostByIdPermalink.get(quotedPostIdVal) : undefined;
      const quotedPostDto = quotedPostFromMap
        ? toPostDto(quotedPostFromMap, r2, {
            videoEmbed: videoEmbedByPostId.get(quotedPostFromMap.id) ?? null,
          })
        : undefined;
      const dto = toPostDto(p, r2, {
        viewerHasBoosted: boosted.has(p.id),
        viewerHasBookmarked: bookmarksByPostId.has(p.id),
        viewerBookmarkCollectionIds: bookmarksByPostId.get(p.id)?.collectionIds ?? [],
        viewerVotedPollOptionId: votedPollOptionIdByPostId.get(p.id) ?? null,
        viewerHasReposted: repostedByPostId.has(p.id),
        viewerHasCommented: commentedByPostId.has(p.id),
        viewerHasViewed: viewedByPostId.has(p.id),
        viewerLastSeenAt: lastSeenAtByPostId.get(p.id)?.toISOString(),
        viewerCreatorSkipped: viewerCreatorSkipped || undefined,
        internalOverride:
          base || (typeof score === 'number' ? { score } : undefined)
            ? { ...base, ...(typeof score === 'number' ? { score } : {}) }
            : undefined,
        repostedPost: opts.repostedPost,
        quotedPost: quotedPostDto,
        // Only the root (requested) post is gated; ancestors are accessible.
        viewerCanAccess: opts.isGatedRoot ? false : undefined,
        groupPreview: resolvedGroupPreview,
        videoEmbed: videoEmbedByPostId.get(p.id) ?? null,
      });
      return opts.parent ? { ...dto, parent: opts.parent } : dto;
    };

    // Build reposted post DTO first (if this is a flat repost).
    const repostedPostDto = repostedPostRaw ? toDto(repostedPostRaw, {}) : undefined;

    // Build from root down: chain[chain.length-1] is root, chain[0] is leaf (the post we're viewing).
    // A chain entry is gated when either (a) the leaf was inaccessible (!viewerCanAccess && i===0)
    // or (b) an ancestor was fetched via getByIdNoAccess because the viewer's tier was too low.
    const rootIdx = chain.length - 1;
    let dto = toDto(chain[rootIdx], {
      repostedPost: repostedPostDto,
      isGatedRoot: gatedChainIndices.has(rootIdx),
      groupPreview: gatedChainIndices.has(rootIdx) ? groupPreview ?? undefined : undefined,
    });
    for (let i = chain.length - 2; i >= 0; i--) {
      const isGated = (!viewerCanAccess && i === 0) || gatedChainIndices.has(i);
      dto = toDto(chain[i], { parent: dto, isGatedRoot: isGated, groupPreview: isGated ? groupPreview ?? undefined : undefined });
    }
    // Single-post case (no parent): the chain has only one entry, already built above.
    if (!viewerCanAccess && chain.length === 1) {
      // Rebuild with gated flag
      dto = toDto(chain[0], { repostedPost: repostedPostDto, isGatedRoot: true, groupPreview });
    }

    setReadCache(httpRes, { viewerUserId });
    return { data: dto };
  }
}



