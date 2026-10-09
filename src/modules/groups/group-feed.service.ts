import { Inject } from '@nestjs/common';
import { PostsFeedListingsService } from '../posts/posts-feed-listings.service';
import { PostsFeedMediaService } from '../posts/posts-feed-media.service';
import { Injectable, NotFoundException } from '@nestjs/common';
import { getGroupMemberOrThrow } from '../viewer/group-membership.queries';
import { PrismaService } from '../prisma/prisma.service';

import { NOT_DELETED } from '../../common/prisma/where';

const COLLAPSE_OPTS = {
  collapseByRoot: true,
  collapseMode: 'root' as const,
  prefer: 'reply' as const,
  collapseMaxPerRoot: 2,
};

/** Group-scoped feeds and media listings. */
@Injectable()
export class GroupFeedService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PostsFeedListingsService) private readonly postsListings: Pick<PostsFeedListingsService, 'assertCanReadCommunityGroup' | 'listComposedGroupScopedFeed'>,
    @Inject(PostsFeedMediaService) private readonly postsMedia: Pick<PostsFeedMediaService, 'listMediaForCommunityGroup' | 'listMediaForGroupsHub'>,
  ) {}

  async groupFeed(params: {
    viewerUserId: string;
    slug: string;
    limit: number;
    cursor: string | null;
    sort: 'new' | 'trending';
    topLevelOnly?: boolean;
  }) {
    const slug = (params.slug ?? '').trim();
    if (!slug) throw new NotFoundException('Group not found.');
    const g = await this.prisma.communityGroup.findFirst({
      where: { slug, ...NOT_DELETED },
    });
    if (!g) throw new NotFoundException('Group not found.');

    // Read access: open groups are visible to any verified user; private groups
    // remain members-only. Composer membership is enforced separately on write.
    await this.postsListings.assertCanReadCommunityGroup(params.viewerUserId, g.id);

    return this.postsListings.listComposedGroupScopedFeed({
      viewerUserId: params.viewerUserId,
      groupIds: [g.id],
      limit: params.limit,
      cursor: params.cursor,
      sort: params.sort,
      applyPinnedHead: params.sort === 'new',
      topLevelOnly: params.topLevelOnly,
      ...COLLAPSE_OPTS,
    });
  }

  async groupMedia(params: {
    viewerUserId: string;
    slug: string;
    limit: number;
    cursor: string | null;
    sort: 'new' | 'trending';
  }) {
    const slug = (params.slug ?? '').trim();
    if (!slug) throw new NotFoundException('Group not found.');
    const g = await this.prisma.communityGroup.findFirst({
      where: { slug, ...NOT_DELETED },
    });
    if (!g) throw new NotFoundException('Group not found.');

    const result = await this.postsMedia.listMediaForCommunityGroup({
      viewerUserId: params.viewerUserId,
      groupId: g.id,
      limit: params.limit,
      cursor: params.cursor,
      sort: params.sort,
    });
    return { data: result.items, pagination: { nextCursor: result.nextCursor } };
  }

  async groupsHubMedia(params: {
    viewerUserId: string;
    limit: number;
    cursor: string | null;
    sort: 'new' | 'trending';
  }) {
    const result = await this.postsMedia.listMediaForGroupsHub({
      viewerUserId: params.viewerUserId,
      limit: params.limit,
      cursor: params.cursor,
      sort: params.sort,
    });
    return { data: result.items, pagination: { nextCursor: result.nextCursor } };
  }

  async myGroupsHubFeed(params: {
    viewerUserId: string;
    groupId: string | null;
    limit: number;
    cursor: string | null;
    sort: 'new' | 'trending';
  }) {
    const filterId = (params.groupId ?? '').trim() || null;

    if (filterId) {
      await getGroupMemberOrThrow(this.prisma, filterId, params.viewerUserId);
      return this.postsListings.listComposedGroupScopedFeed({
        viewerUserId: params.viewerUserId,
        groupIds: [filterId],
        limit: params.limit,
        cursor: params.cursor,
        sort: params.sort,
        applyPinnedHead: params.sort === 'new',
        ...COLLAPSE_OPTS,
      });
    }

    const memberships = await this.prisma.communityGroupMember.findMany({
      where: { userId: params.viewerUserId, status: 'active' },
      select: { groupId: true },
    });
    const groupIds = memberships.map((m) => m.groupId);
    if (groupIds.length === 0) {
      return { data: [], pagination: { nextCursor: null as string | null } };
    }

    return this.postsListings.listComposedGroupScopedFeed({
      viewerUserId: params.viewerUserId,
      groupIds,
      limit: params.limit,
      cursor: params.cursor,
      sort: params.sort,
      applyPinnedHead: false,
      ...COLLAPSE_OPTS,
    });
  }
}
