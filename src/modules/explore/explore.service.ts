import { Injectable } from '@nestjs/common';
import { PostsService } from '../posts/posts.service';
import { TopicsService } from '../topics/topics.service';
import { ArticlesService } from '../articles/articles.service';
import { GroupsService } from '../groups/groups.service';
import { HashtagsService } from '../hashtags/hashtags.service';
import { FollowsService } from '../follows/follows.service';
import { CheckinsService } from '../checkins/checkins.service';
import { PresenceRedisStateService } from '../presence/presence-redis-state.service';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { toUserListDto } from '../../common/dto';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';

@Injectable()
export class ExploreService {
  constructor(
    private readonly posts: PostsService,
    private readonly topics: TopicsService,
    private readonly articles: ArticlesService,
    private readonly groups: GroupsService,
    private readonly hashtags: HashtagsService,
    private readonly follows: FollowsService,
    private readonly checkins: CheckinsService,
    private readonly presenceRedis: PresenceRedisStateService,
    private readonly appConfig: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private get r2BaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  async aggregate(params: { viewerUserId: string | null }) {
    const { viewerUserId } = params;
    const publicBaseUrl = this.r2BaseUrl;

    // Run all unconditional sections in parallel.
    const [
      featuredResult,
      categoriesResult,
      trendingArticles,
      groupsResult,
      hashtagsResult,
      topUsersResult,
      onlineUserIds,
    ] = await Promise.all([
      this.posts.listFeaturedFeed({
        viewerUserId,
        limit: 8,
        cursor: null,
        visibility: 'all',
        includeSelf: true,
      }),
      this.topics.listCategories({ viewerUserId, limit: 20 }),
      this.articles.listTrending({ viewerUserId, limit: 6 }),
      this.groups.listExploreSpotlight(viewerUserId, { take: 8 }),
      this.hashtags.trendingHashtags({ viewerUserId, limit: 15, cursor: null }),
      this.follows.listTopUsers({ viewerUserId, limit: 12 }),
      this.presenceRedis.onlineUserIds(),
    ]);

    const featuredDtos = await this.posts.composeFeedPostDtos({
      viewerUserId,
      filteredPosts: featuredResult.posts,
      collapsedCountByItemId: new Map(),
      scoreByPostId: (featuredResult as { scoreByPostId?: Map<string, number> }).scoreByPostId,
    });

    // Authenticated-only sections — run in parallel with each other.
    let followedTopics: Awaited<ReturnType<TopicsService['listFollowedTopics']>> = [];
    let recommendedUsers: Awaited<ReturnType<FollowsService['recommendUsersToFollow']>>['users'] = [];
    let newestUsers: ReturnType<typeof toUserListDto>[] = [];
    let checkin: Awaited<ReturnType<CheckinsService['getTodayState']>> | null = null;

    if (viewerUserId) {
      const [followedTopicsResult, recsResult, newestRaw, checkinResult] = await Promise.all([
        this.topics.listFollowedTopics({ viewerUserId, limit: 50 }),
        this.follows.recommendUsersToFollow({ viewerUserId, limit: 16 }),
        this.prisma.user.findMany({
          where: {
            usernameIsSet: true,
            bannedAt: null,
            id: { not: viewerUserId },
            followers: { none: { followerId: viewerUserId } },
          },
          select: USER_LIST_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 16,
        }),
        this.checkins.getTodayState({ userId: viewerUserId, publicBaseUrl }).catch(() => null),
      ]);

      followedTopics = followedTopicsResult;
      recommendedUsers = recsResult.users;

      const newestUserIds = newestRaw.map((u) => u.id);
      const newestRel = await this.follows.batchRelationshipForUserIds({ viewerUserId, userIds: newestUserIds });
      newestUsers = newestRaw.map((u) =>
        toUserListDto(u, publicBaseUrl, {
          relationship: {
            viewerFollowsUser: newestRel.viewerFollows.has(u.id),
            userFollowsViewer: newestRel.followsViewer.has(u.id),
            viewerPostNotificationsEnabled: newestRel.viewerBellEnabled.has(u.id),
          },
        }),
      );

      checkin = checkinResult;
    }

    return {
      featured: featuredDtos,
      featuredNextCursor: featuredResult.nextCursor,
      categories: categoriesResult,
      trendingArticles,
      groups: groupsResult,
      trendingHashtags: hashtagsResult.hashtags,
      topUsers: topUsersResult.users,
      onlineCount: onlineUserIds.length,
      // Authenticated-only fields (null/empty when not authed).
      followedTopics: viewerUserId ? followedTopics : null,
      recommendations: viewerUserId ? recommendedUsers : null,
      newestUsers: viewerUserId ? newestUsers : null,
      checkin: viewerUserId ? checkin : null,
    };
  }
}
