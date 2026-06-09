import { Injectable } from '@nestjs/common';
import { PollsService } from './polls.service';
import { PostsRankingService } from './posts-ranking.service';
import { PostsDraftsService } from './posts-drafts.service';
import { PostsEngagementService } from './posts-engagement.service';
import { PostsViewerEnrichmentService } from './posts-viewer-enrichment.service';
import { PostsFeedQueryService } from './posts-feed-query.service';
import { PostsMutationService } from './posts-mutation.service';

export type { PostCounts } from './posts-feed.types';

/**
 * Facade over the posts domain. Controllers and other modules depend on this
 * stable surface; the actual logic lives in focused sub-services:
 *
 *   - PostsFeedQueryService        — read paths (feeds, threads, lookups, media grids)
 *   - PostsMutationService         — create/update/delete + publish + side effects
 *   - PostsViewerEnrichmentService — viewer overlay data (boosted/bookmarked/blocks/tiers)
 *   - PostsEngagementService       — boost/repost mutations
 *   - PostsDraftsService           — draft rows
 *   - PostsRankingService          — trending/popular score computation
 *   - PollsService                 — poll voting
 */
@Injectable()
export class PostsService {
  constructor(
    private readonly polls: PollsService,
    private readonly ranking: PostsRankingService,
    private readonly drafts: PostsDraftsService,
    private readonly engagement: PostsEngagementService,
    private readonly enrichment: PostsViewerEnrichmentService,
    private readonly feedQuery: PostsFeedQueryService,
    private readonly mutation: PostsMutationService,
  ) {}

  // ── Ranking ────────────────────────────────────────────────────────────────

  ensureBoostScoresFresh(...args: Parameters<PostsRankingService['ensureBoostScoresFresh']>) {
    return this.ranking.ensureBoostScoresFresh(...args);
  }

  computeScoresForPostIds(...args: Parameters<PostsRankingService['computeScoresForPostIds']>) {
    return this.ranking.computeScoresForPostIds(...args);
  }

  refreshAndStoreTrendingScore(...args: Parameters<PostsRankingService['refreshAndStoreTrendingScore']>) {
    return this.ranking.refreshAndStoreTrendingScore(...args);
  }

  // ── Viewer enrichment ──────────────────────────────────────────────────────

  viewerContext(...args: Parameters<PostsViewerEnrichmentService['viewerContext']>) {
    return this.enrichment.viewerContext(...args);
  }

  viewerBoostedPostIds(...args: Parameters<PostsViewerEnrichmentService['viewerBoostedPostIds']>) {
    return this.enrichment.viewerBoostedPostIds(...args);
  }

  viewerRepostedPostIds(...args: Parameters<PostsViewerEnrichmentService['viewerRepostedPostIds']>) {
    return this.enrichment.viewerRepostedPostIds(...args);
  }

  viewerBookmarksByPostId(...args: Parameters<PostsViewerEnrichmentService['viewerBookmarksByPostId']>) {
    return this.enrichment.viewerBookmarksByPostId(...args);
  }

  viewerVotedPollOptionIdByPostId(...args: Parameters<PostsViewerEnrichmentService['viewerVotedPollOptionIdByPostId']>) {
    return this.enrichment.viewerVotedPollOptionIdByPostId(...args);
  }

  allowedVisibilities(...args: Parameters<PostsViewerEnrichmentService['allowedVisibilities']>) {
    return this.enrichment.allowedVisibilities(...args);
  }

  viewerBlockSets(...args: Parameters<PostsViewerEnrichmentService['viewerBlockSets']>) {
    return this.enrichment.viewerBlockSets(...args);
  }

  invalidateBlockSetsCache(...args: Parameters<PostsViewerEnrichmentService['invalidateBlockSetsCache']>) {
    return this.enrichment.invalidateBlockSetsCache(...args);
  }

  // ── Feed / read queries ────────────────────────────────────────────────────

  listOnlyMe(...args: Parameters<PostsFeedQueryService['listOnlyMe']>) {
    return this.feedQuery.listOnlyMe(...args);
  }

  listFeed(...args: Parameters<PostsFeedQueryService['listFeed']>) {
    return this.feedQuery.listFeed(...args);
  }

  listActiveCommunityGroupIdsForUser(...args: Parameters<PostsFeedQueryService['listActiveCommunityGroupIdsForUser']>) {
    return this.feedQuery.listActiveCommunityGroupIdsForUser(...args);
  }

  assertCanReadCommunityGroup(...args: Parameters<PostsFeedQueryService['assertCanReadCommunityGroup']>) {
    return this.feedQuery.assertCanReadCommunityGroup(...args);
  }

  listCommunityGroupsTimelinePosts(...args: Parameters<PostsFeedQueryService['listCommunityGroupsTimelinePosts']>) {
    return this.feedQuery.listCommunityGroupsTimelinePosts(...args);
  }

  collectParentMapForFeed(...args: Parameters<PostsFeedQueryService['collectParentMapForFeed']>) {
    return this.feedQuery.collectParentMapForFeed(...args);
  }

  collectRepostedMapForFeed(...args: Parameters<PostsFeedQueryService['collectRepostedMapForFeed']>) {
    return this.feedQuery.collectRepostedMapForFeed(...args);
  }

  communityGroupPreviewMapForFeed(...args: Parameters<PostsFeedQueryService['communityGroupPreviewMapForFeed']>) {
    return this.feedQuery.communityGroupPreviewMapForFeed(...args);
  }

  composeFeedPostDtos(...args: Parameters<PostsFeedQueryService['composeFeedPostDtos']>) {
    return this.feedQuery.composeFeedPostDtos(...args);
  }

  listComposedGroupScopedFeed(...args: Parameters<PostsFeedQueryService['listComposedGroupScopedFeed']>) {
    return this.feedQuery.listComposedGroupScopedFeed(...args);
  }

  communityGroupPreviewForGroup(...args: Parameters<PostsFeedQueryService['communityGroupPreviewForGroup']>) {
    return this.feedQuery.communityGroupPreviewForGroup(...args);
  }

  listForYouFeed(...args: Parameters<PostsFeedQueryService['listForYouFeed']>) {
    return this.feedQuery.listForYouFeed(...args);
  }

  listPopularFeed(...args: Parameters<PostsFeedQueryService['listPopularFeed']>) {
    return this.feedQuery.listPopularFeed(...args);
  }

  listFeaturedFeed(...args: Parameters<PostsFeedQueryService['listFeaturedFeed']>) {
    return this.feedQuery.listFeaturedFeed(...args);
  }

  listForUsername(...args: Parameters<PostsFeedQueryService['listForUsername']>) {
    return this.feedQuery.listForUsername(...args);
  }

  listComments(...args: Parameters<PostsFeedQueryService['listComments']>) {
    return this.feedQuery.listComments(...args);
  }

  getThreadParticipants(...args: Parameters<PostsFeedQueryService['getThreadParticipants']>) {
    return this.feedQuery.getThreadParticipants(...args);
  }

  getById(...args: Parameters<PostsFeedQueryService['getById']>) {
    return this.feedQuery.getById(...args);
  }

  getByIds(...args: Parameters<PostsFeedQueryService['getByIds']>) {
    return this.feedQuery.getByIds(...args);
  }

  getByIdNoAccess(...args: Parameters<PostsFeedQueryService['getByIdNoAccess']>) {
    return this.feedQuery.getByIdNoAccess(...args);
  }

  listMediaForUsername(...args: Parameters<PostsFeedQueryService['listMediaForUsername']>) {
    return this.feedQuery.listMediaForUsername(...args);
  }

  listMediaForGroupsHub(...args: Parameters<PostsFeedQueryService['listMediaForGroupsHub']>) {
    return this.feedQuery.listMediaForGroupsHub(...args);
  }

  listMediaForCommunityGroup(...args: Parameters<PostsFeedQueryService['listMediaForCommunityGroup']>) {
    return this.feedQuery.listMediaForCommunityGroup(...args);
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  createPost(...args: Parameters<PostsMutationService['createPost']>) {
    return this.mutation.createPost(...args);
  }

  updatePost(...args: Parameters<PostsMutationService['updatePost']>) {
    return this.mutation.updatePost(...args);
  }

  deletePost(...args: Parameters<PostsMutationService['deletePost']>) {
    return this.mutation.deletePost(...args);
  }

  publishFromOnlyMe(...args: Parameters<PostsMutationService['publishFromOnlyMe']>) {
    return this.mutation.publishFromOnlyMe(...args);
  }

  invalidateSiteConfigCache(...args: Parameters<PostsMutationService['invalidateSiteConfigCache']>) {
    return this.mutation.invalidateSiteConfigCache(...args);
  }

  // ── Drafts ─────────────────────────────────────────────────────────────────

  listDrafts(...args: Parameters<PostsDraftsService['listDrafts']>) {
    return this.drafts.listDrafts(...args);
  }

  createDraft(...args: Parameters<PostsDraftsService['createDraft']>) {
    return this.drafts.createDraft(...args);
  }

  updateDraft(...args: Parameters<PostsDraftsService['updateDraft']>) {
    return this.drafts.updateDraft(...args);
  }

  deleteDraft(...args: Parameters<PostsDraftsService['deleteDraft']>) {
    return this.drafts.deleteDraft(...args);
  }

  // ── Polls ──────────────────────────────────────────────────────────────────

  voteOnPoll(...args: Parameters<PollsService['voteOnPoll']>) {
    return this.polls.voteOnPoll(...args);
  }

  skipPoll(...args: Parameters<PollsService['skipPoll']>) {
    return this.polls.skipPoll(...args);
  }

  // ── Engagement ─────────────────────────────────────────────────────────────

  boostPost(...args: Parameters<PostsEngagementService['boostPost']>) {
    return this.engagement.boostPost(...args);
  }

  unboostPost(...args: Parameters<PostsEngagementService['unboostPost']>) {
    return this.engagement.unboostPost(...args);
  }

  repostPost(...args: Parameters<PostsEngagementService['repostPost']>) {
    return this.engagement.repostPost(...args);
  }

  unrepostPost(...args: Parameters<PostsEngagementService['unrepostPost']>) {
    return this.engagement.unrepostPost(...args);
  }
}
