import { PollsService } from './polls.service';
import { PostsRankingService } from './posts-ranking.service';
import { PostsDraftsService } from './posts-drafts.service';
import { PostsEngagementService } from './posts-engagement.service';
import { PostsViewerEnrichmentService } from './posts-viewer-enrichment.service';
import { PostsFeedListingsService } from './posts-feed-listings.service';
import { PostsFeedComposeService } from './posts-feed-compose.service';
import { PostsFeedForYouService } from './posts-feed-for-you.service';
import { PostsFeedPopularService } from './posts-feed-popular.service';
import { PostsFeedFeaturedService } from './posts-feed-featured.service';
import { PostsFeedProfileService } from './posts-feed-profile.service';
import { PostsFeedMediaService } from './posts-feed-media.service';
import { PostsFeedLookupService } from './posts-feed-lookup.service';
import { PostsDiscoverMoreService } from './posts-discover-more.service';
import { PostsMutationEditsService } from './posts-mutation-edits.service';
import { PostsMutationWriteService } from './posts-mutation-write.service';

export type { PostCounts } from './posts-feed.types';

/** Test-only composition preserves existing behavioral regression fixtures. Production callers inject focused collaborators directly. */
function bindFixtureMethod<A extends unknown[], R>(
  owner: unknown,
  method: ((...args: A) => R) | undefined,
  name: string,
): (...args: A) => R {
  if (method) return method.bind(owner);
  return (..._args: A): R => {
    throw new Error(`Missing collaborator method ${name} in a partial post test fixture.`);
  };
}

export class TestPostsFacade {
  readonly ensureBoostScoresFresh: PostsRankingService['ensureBoostScoresFresh'];
  readonly computeScoresForPostIds: PostsRankingService['computeScoresForPostIds'];
  readonly refreshAndStoreTrendingScore: PostsRankingService['refreshAndStoreTrendingScore'];
  readonly viewerContext: PostsViewerEnrichmentService['viewerContext'];
  readonly viewerBoostedPostIds: PostsViewerEnrichmentService['viewerBoostedPostIds'];
  readonly viewerCommentedPostIds: PostsViewerEnrichmentService['viewerCommentedPostIds'];
  readonly viewerRepostedPostIds: PostsViewerEnrichmentService['viewerRepostedPostIds'];
  readonly viewerViewedPostIds: PostsViewerEnrichmentService['viewerViewedPostIds'];
  readonly viewerLastSeenAtByPostId: PostsViewerEnrichmentService['viewerLastSeenAtByPostId'];
  readonly viewerBookmarksByPostId: PostsViewerEnrichmentService['viewerBookmarksByPostId'];
  readonly viewerVotedPollOptionIdByPostId: PostsViewerEnrichmentService['viewerVotedPollOptionIdByPostId'];
  readonly allowedVisibilities: PostsViewerEnrichmentService['allowedVisibilities'];
  readonly viewerBlockSets: PostsViewerEnrichmentService['viewerBlockSets'];
  readonly invalidateBlockSetsCache: PostsViewerEnrichmentService['invalidateBlockSetsCache'];
  readonly listOnlyMe: PostsFeedListingsService['listOnlyMe'];
  readonly listFeed: PostsFeedListingsService['listFeed'];
  readonly listActiveCommunityGroupIdsForUser: PostsFeedListingsService['listActiveCommunityGroupIdsForUser'];
  readonly assertCanReadCommunityGroup: PostsFeedListingsService['assertCanReadCommunityGroup'];
  readonly listCommunityGroupsTimelinePosts: PostsFeedListingsService['listCommunityGroupsTimelinePosts'];
  readonly collectParentMapForFeed: PostsFeedComposeService['collectParentMapForFeed'];
  readonly collectRepostedMapForFeed: PostsFeedComposeService['collectRepostedMapForFeed'];
  readonly communityGroupPreviewMapForFeed: PostsFeedComposeService['communityGroupPreviewMapForFeed'];
  readonly composeFeedPostDtos: PostsFeedComposeService['composeFeedPostDtos'];
  readonly listComposedGroupScopedFeed: PostsFeedListingsService['listComposedGroupScopedFeed'];
  readonly communityGroupPreviewForGroup: PostsFeedListingsService['communityGroupPreviewForGroup'];
  readonly listForYouFeed: PostsFeedForYouService['listForYouFeed'];
  readonly listPopularFeed: PostsFeedPopularService['listPopularFeed'];
  readonly listFeaturedFeed: PostsFeedFeaturedService['listFeaturedFeed'];
  readonly listForUsername: PostsFeedProfileService['listForUsername'];
  readonly listReposters: PostsFeedMediaService['listReposters'];
  readonly listQuotes: PostsFeedMediaService['listQuotes'];
  readonly listDiscoverMore: PostsDiscoverMoreService['listDiscoverMore'];
  readonly listComments: PostsFeedLookupService['listComments'];
  readonly getThreadParticipants: PostsFeedLookupService['getThreadParticipants'];
  readonly getById: PostsFeedLookupService['getById'];
  readonly getLatestPublic: PostsFeedListingsService['getLatestPublic'];
  readonly getPublicById: PostsFeedListingsService['getPublicById'];
  readonly getByIds: PostsFeedComposeService['getByIds'];
  readonly collectAncestorPostIds: PostsFeedComposeService['collectAncestorPostIds'];
  readonly videoEmbedsForPosts: PostsFeedComposeService['videoEmbedsForPosts'];
  readonly getByIdNoAccess: PostsFeedLookupService['getByIdNoAccess'];
  readonly listMediaForUsername: PostsFeedMediaService['listMediaForUsername'];
  readonly listMediaForGroupsHub: PostsFeedMediaService['listMediaForGroupsHub'];
  readonly listMediaForCommunityGroup: PostsFeedMediaService['listMediaForCommunityGroup'];
  readonly createMarvReply: PostsMutationWriteService['createMarvReply'];
  readonly createPost: PostsMutationWriteService['createPost'];
  readonly updatePost: PostsMutationEditsService['updatePost'];
  readonly deletePost: PostsMutationEditsService['deletePost'];
  readonly publishFromOnlyMe: PostsMutationEditsService['publishFromOnlyMe'];
  readonly listDrafts: PostsDraftsService['listDrafts'];
  readonly createDraft: PostsDraftsService['createDraft'];
  readonly updateDraft: PostsDraftsService['updateDraft'];
  readonly deleteDraft: PostsDraftsService['deleteDraft'];
  readonly voteOnPoll: PollsService['voteOnPoll'];
  readonly skipPoll: PollsService['skipPoll'];
  readonly boostPost: PostsEngagementService['boostPost'];
  readonly unboostPost: PostsEngagementService['unboostPost'];
  readonly repostPost: PostsEngagementService['repostPost'];
  readonly unrepostPost: PostsEngagementService['unrepostPost'];

  constructor(
    polls: PollsService,
    ranking: PostsRankingService,
    drafts: PostsDraftsService,
    engagement: PostsEngagementService,
    enrichment: PostsViewerEnrichmentService,
    listings: PostsFeedListingsService,
    compose: PostsFeedComposeService,
    forYou: PostsFeedForYouService,
    popular: PostsFeedPopularService,
    featured: PostsFeedFeaturedService,
    profile: PostsFeedProfileService,
    media: PostsFeedMediaService,
    lookup: PostsFeedLookupService,
    discoverMore: PostsDiscoverMoreService,
    mutationWrite: PostsMutationWriteService,
    mutationEdits: PostsMutationEditsService,
  ) {
    this.ensureBoostScoresFresh = bindFixtureMethod(ranking, ranking.ensureBoostScoresFresh, 'ranking.ensureBoostScoresFresh');
    this.computeScoresForPostIds = bindFixtureMethod(ranking, ranking.computeScoresForPostIds, 'ranking.computeScoresForPostIds');
    this.refreshAndStoreTrendingScore = bindFixtureMethod(ranking, ranking.refreshAndStoreTrendingScore, 'ranking.refreshAndStoreTrendingScore');
    this.viewerContext = bindFixtureMethod(enrichment, enrichment.viewerContext, 'enrichment.viewerContext');
    this.viewerBoostedPostIds = bindFixtureMethod(enrichment, enrichment.viewerBoostedPostIds, 'enrichment.viewerBoostedPostIds');
    this.viewerCommentedPostIds = bindFixtureMethod(enrichment, enrichment.viewerCommentedPostIds, 'enrichment.viewerCommentedPostIds');
    this.viewerRepostedPostIds = bindFixtureMethod(enrichment, enrichment.viewerRepostedPostIds, 'enrichment.viewerRepostedPostIds');
    this.viewerViewedPostIds = bindFixtureMethod(enrichment, enrichment.viewerViewedPostIds, 'enrichment.viewerViewedPostIds');
    this.viewerLastSeenAtByPostId = bindFixtureMethod(enrichment, enrichment.viewerLastSeenAtByPostId, 'enrichment.viewerLastSeenAtByPostId');
    this.viewerBookmarksByPostId = bindFixtureMethod(enrichment, enrichment.viewerBookmarksByPostId, 'enrichment.viewerBookmarksByPostId');
    this.viewerVotedPollOptionIdByPostId = bindFixtureMethod(enrichment, enrichment.viewerVotedPollOptionIdByPostId, 'enrichment.viewerVotedPollOptionIdByPostId');
    this.allowedVisibilities = bindFixtureMethod(enrichment, enrichment.allowedVisibilities, 'enrichment.allowedVisibilities');
    this.viewerBlockSets = bindFixtureMethod(enrichment, enrichment.viewerBlockSets, 'enrichment.viewerBlockSets');
    this.invalidateBlockSetsCache = bindFixtureMethod(enrichment, enrichment.invalidateBlockSetsCache, 'enrichment.invalidateBlockSetsCache');
    this.listOnlyMe = bindFixtureMethod(listings, listings.listOnlyMe, 'listings.listOnlyMe');
    this.listFeed = bindFixtureMethod(listings, listings.listFeed, 'listings.listFeed');
    this.listActiveCommunityGroupIdsForUser = bindFixtureMethod(listings, listings.listActiveCommunityGroupIdsForUser, 'listings.listActiveCommunityGroupIdsForUser');
    this.assertCanReadCommunityGroup = bindFixtureMethod(listings, listings.assertCanReadCommunityGroup, 'listings.assertCanReadCommunityGroup');
    this.listCommunityGroupsTimelinePosts = bindFixtureMethod(listings, listings.listCommunityGroupsTimelinePosts, 'listings.listCommunityGroupsTimelinePosts');
    this.collectParentMapForFeed = bindFixtureMethod(compose, compose.collectParentMapForFeed, 'compose.collectParentMapForFeed');
    this.collectRepostedMapForFeed = bindFixtureMethod(compose, compose.collectRepostedMapForFeed, 'compose.collectRepostedMapForFeed');
    this.communityGroupPreviewMapForFeed = bindFixtureMethod(compose, compose.communityGroupPreviewMapForFeed, 'compose.communityGroupPreviewMapForFeed');
    this.composeFeedPostDtos = bindFixtureMethod(compose, compose.composeFeedPostDtos, 'compose.composeFeedPostDtos');
    this.listComposedGroupScopedFeed = bindFixtureMethod(listings, listings.listComposedGroupScopedFeed, 'listings.listComposedGroupScopedFeed');
    this.communityGroupPreviewForGroup = bindFixtureMethod(listings, listings.communityGroupPreviewForGroup, 'listings.communityGroupPreviewForGroup');
    this.listForYouFeed = bindFixtureMethod(forYou, forYou.listForYouFeed, 'forYou.listForYouFeed');
    this.listPopularFeed = bindFixtureMethod(popular, popular.listPopularFeed, 'popular.listPopularFeed');
    this.listFeaturedFeed = bindFixtureMethod(featured, featured.listFeaturedFeed, 'featured.listFeaturedFeed');
    this.listForUsername = bindFixtureMethod(profile, profile.listForUsername, 'profile.listForUsername');
    this.listReposters = bindFixtureMethod(media, media.listReposters, 'media.listReposters');
    this.listQuotes = bindFixtureMethod(media, media.listQuotes, 'media.listQuotes');
    this.listDiscoverMore = bindFixtureMethod(discoverMore, discoverMore.listDiscoverMore, 'discoverMore.listDiscoverMore');
    this.listComments = bindFixtureMethod(lookup, lookup.listComments, 'lookup.listComments');
    this.getThreadParticipants = bindFixtureMethod(lookup, lookup.getThreadParticipants, 'lookup.getThreadParticipants');
    this.getById = bindFixtureMethod(lookup, lookup.getById, 'lookup.getById');
    this.getLatestPublic = bindFixtureMethod(listings, listings.getLatestPublic, 'listings.getLatestPublic');
    this.getPublicById = bindFixtureMethod(listings, listings.getPublicById, 'listings.getPublicById');
    this.getByIds = bindFixtureMethod(compose, compose.getByIds, 'compose.getByIds');
    this.collectAncestorPostIds = bindFixtureMethod(compose, compose.collectAncestorPostIds, 'compose.collectAncestorPostIds');
    this.videoEmbedsForPosts = bindFixtureMethod(compose, compose.videoEmbedsForPosts, 'compose.videoEmbedsForPosts');
    this.getByIdNoAccess = bindFixtureMethod(lookup, lookup.getByIdNoAccess, 'lookup.getByIdNoAccess');
    this.listMediaForUsername = bindFixtureMethod(media, media.listMediaForUsername, 'media.listMediaForUsername');
    this.listMediaForGroupsHub = bindFixtureMethod(media, media.listMediaForGroupsHub, 'media.listMediaForGroupsHub');
    this.listMediaForCommunityGroup = bindFixtureMethod(media, media.listMediaForCommunityGroup, 'media.listMediaForCommunityGroup');
    this.createMarvReply = bindFixtureMethod(mutationWrite, mutationWrite.createMarvReply, 'mutationWrite.createMarvReply');
    this.createPost = bindFixtureMethod(mutationWrite, mutationWrite.createPost, 'mutationWrite.createPost');
    this.updatePost = bindFixtureMethod(mutationEdits, mutationEdits.updatePost, 'mutationEdits.updatePost');
    this.deletePost = bindFixtureMethod(mutationEdits, mutationEdits.deletePost, 'mutationEdits.deletePost');
    this.publishFromOnlyMe = bindFixtureMethod(mutationEdits, mutationEdits.publishFromOnlyMe, 'mutationEdits.publishFromOnlyMe');
    this.listDrafts = bindFixtureMethod(drafts, drafts.listDrafts, 'drafts.listDrafts');
    this.createDraft = bindFixtureMethod(drafts, drafts.createDraft, 'drafts.createDraft');
    this.updateDraft = bindFixtureMethod(drafts, drafts.updateDraft, 'drafts.updateDraft');
    this.deleteDraft = bindFixtureMethod(drafts, drafts.deleteDraft, 'drafts.deleteDraft');
    this.voteOnPoll = bindFixtureMethod(polls, polls.voteOnPoll, 'polls.voteOnPoll');
    this.skipPoll = bindFixtureMethod(polls, polls.skipPoll, 'polls.skipPoll');
    this.boostPost = bindFixtureMethod(engagement, engagement.boostPost, 'engagement.boostPost');
    this.unboostPost = bindFixtureMethod(engagement, engagement.unboostPost, 'engagement.unboostPost');
    this.repostPost = bindFixtureMethod(engagement, engagement.repostPost, 'engagement.repostPost');
    this.unrepostPost = bindFixtureMethod(engagement, engagement.unrepostPost, 'engagement.unrepostPost');
  }
}
