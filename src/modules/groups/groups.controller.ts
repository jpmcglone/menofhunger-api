import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
import { GroupsService } from './groups.service';
import { PrismaService } from '../prisma/prisma.service';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';

const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  sort: z.enum(['new', 'trending']).optional(),
});

const myHubFeedQuerySchema = feedQuerySchema.extend({
  groupId: z.string().trim().min(1).max(40).optional(),
});

const membersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  q: z.string().trim().max(80).optional(),
});

const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(160),
  rules: z.string().trim().max(8000).nullish(),
  coverImageUrl: z.string().trim().max(2000).nullish(),
  avatarImageUrl: z.string().trim().max(2000).nullish(),
  joinPolicy: z.enum(['open', 'approval']),
});

const updateGroupSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().min(1).max(160).optional(),
  rules: z.string().trim().max(8000).nullish(),
  coverImageUrl: z.string().trim().max(2000).nullish(),
  avatarImageUrl: z.string().trim().max(2000).nullish(),
  joinPolicy: z.enum(['open', 'approval']).optional(),
  isFeatured: z.boolean().optional(),
  featuredOrder: z.coerce.number().int().min(0).max(9999).optional(),
});

@Controller('groups')
export class GroupsController {
  constructor(
    private readonly groups: GroupsService,
    private readonly prisma: PrismaService,
  ) {}

  @UseGuards(AuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('publicRead', 120), ttl: rateLimitTtl('publicRead', 60) },
  })
  @Get('featured')
  async featured(@CurrentUserId() viewerUserId: string) {
    return await this.groups.listFeatured({ viewerUserId });
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('publicRead', 120), ttl: rateLimitTtl('publicRead', 60) },
  })
  @Get('me')
  async mine(@CurrentUserId() viewerUserId: string) {
    return await this.groups.listMine({ viewerUserId });
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('publicRead', 120), ttl: rateLimitTtl('publicRead', 60) },
  })
  @Get('me/feed')
  async myHubFeed(@CurrentUserId() viewerUserId: string, @Query() query: unknown) {
    const parsed = myHubFeedQuerySchema.parse(query);
    return await this.groups.myGroupsHubFeed({
      viewerUserId,
      groupId: parsed.groupId ?? null,
      limit: parsed.limit ?? 30,
      cursor: parsed.cursor ?? null,
      sort: parsed.sort === 'trending' ? 'trending' : 'new',
    });
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('publicRead', 120), ttl: rateLimitTtl('publicRead', 60) },
  })
  @Get('explore')
  async explore(@OptionalCurrentUserId() userId: string | undefined) {
    return await this.groups.listExploreSpotlight(userId ?? null);
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('publicRead', 120), ttl: rateLimitTtl('publicRead', 60) },
  })
  @Get('by-slug/:slug')
  async bySlug(@OptionalCurrentUserId() viewerUserId: string | undefined, @Param('slug') slug: string) {
    return await this.groups.getShellBySlug({ slug, viewerUserId: viewerUserId ?? null });
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('publicRead', 120), ttl: rateLimitTtl('publicRead', 60) },
  })
  @Get('by-slug/:slug/feed')
  async feed(
    @CurrentUserId() viewerUserId: string,
    @Param('slug') slug: string,
    @Query() query: unknown,
  ) {
    const parsed = feedQuerySchema.parse(query);
    return await this.groups.groupFeed({
      viewerUserId,
      slug,
      limit: parsed.limit ?? 30,
      cursor: parsed.cursor ?? null,
      sort: parsed.sort === 'trending' ? 'trending' : 'new',
    });
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('postCreate', 20), ttl: rateLimitTtl('postCreate', 60) },
  })
  @Post()
  async create(@CurrentUserId() viewerUserId: string, @Body() body: unknown) {
    const parsed = createGroupSchema.parse(body);
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: viewerUserId },
      select: { premium: true, premiumPlus: true, siteAdmin: true },
    });
    const isPremium = Boolean(u.premium || u.premiumPlus);
    return await this.groups.create({
      viewerUserId,
      isPremium,
      isSiteAdmin: Boolean(u.siteAdmin),
      name: parsed.name,
      description: parsed.description,
      rules: parsed.rules ?? null,
      coverImageUrl: parsed.coverImageUrl ?? null,
      avatarImageUrl: parsed.avatarImageUrl ?? null,
      joinPolicy: parsed.joinPolicy,
    });
  }

  @UseGuards(AuthGuard)
  @Patch(':groupId')
  async update(@CurrentUserId() viewerUserId: string, @Param('groupId') groupId: string, @Body() body: unknown) {
    const parsed = updateGroupSchema.parse(body);
    const u = await this.prisma.user.findUnique({
      where: { id: viewerUserId },
      select: { siteAdmin: true },
    });
    return await this.groups.updateGroup({
      viewerUserId,
      isSiteAdmin: Boolean(u?.siteAdmin),
      groupId,
      ...parsed,
    });
  }

  @UseGuards(AuthGuard)
  @Post(':groupId/join')
  async join(@CurrentUserId() viewerUserId: string, @Param('groupId') groupId: string) {
    return await this.groups.join({ viewerUserId, groupId });
  }

  @UseGuards(AuthGuard)
  @Post(':groupId/leave')
  async leave(@CurrentUserId() viewerUserId: string, @Param('groupId') groupId: string) {
    return await this.groups.leave({ viewerUserId, groupId });
  }

  @UseGuards(AuthGuard)
  @Post(':groupId/cancel-request')
  async cancelRequest(@CurrentUserId() viewerUserId: string, @Param('groupId') groupId: string) {
    return await this.groups.cancelRequest({ viewerUserId, groupId });
  }

  @UseGuards(AuthGuard)
  @Get(':groupId/pending-members')
  async pending(@CurrentUserId() viewerUserId: string, @Param('groupId') groupId: string) {
    return await this.groups.listPending({ viewerUserId, groupId });
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('publicRead', 120), ttl: rateLimitTtl('publicRead', 60) },
  })
  @Get(':groupId/members')
  async members(
    @CurrentUserId() viewerUserId: string,
    @Param('groupId') groupId: string,
    @Query() query: unknown,
  ) {
    const parsed = membersQuerySchema.parse(query);
    return await this.groups.listMembers({
      viewerUserId,
      groupId,
      limit: parsed.limit ?? 30,
      cursor: parsed.cursor ?? null,
      q: parsed.q ?? null,
    });
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('postCreate', 30), ttl: rateLimitTtl('postCreate', 60) },
  })
  @Post(':groupId/pin/:postId')
  async pinPost(
    @CurrentUserId() viewerUserId: string,
    @Param('groupId') groupId: string,
    @Param('postId') postId: string,
  ) {
    return await this.groups.pinPost({ viewerUserId, groupId, postId });
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: { limit: rateLimitLimit('postCreate', 30), ttl: rateLimitTtl('postCreate', 60) },
  })
  @Delete(':groupId/pin')
  async unpinPost(@CurrentUserId() viewerUserId: string, @Param('groupId') groupId: string) {
    return await this.groups.unpinGroupPost({ viewerUserId, groupId });
  }

  @UseGuards(AuthGuard)
  @Post(':groupId/members/:userId/approve')
  async approve(@CurrentUserId() viewerUserId: string, @Param('groupId') groupId: string, @Param('userId') userId: string) {
    return await this.groups.approveMember({ viewerUserId, groupId, userId });
  }

  @UseGuards(AuthGuard)
  @Post(':groupId/members/:userId/reject')
  async reject(@CurrentUserId() viewerUserId: string, @Param('groupId') groupId: string, @Param('userId') userId: string) {
    return await this.groups.rejectMember({ viewerUserId, groupId, userId });
  }

  @UseGuards(AuthGuard)
  @Delete(':groupId/members/:userId')
  async remove(@CurrentUserId() viewerUserId: string, @Param('groupId') groupId: string, @Param('userId') userId: string) {
    return await this.groups.removeMember({ viewerUserId, groupId, userId });
  }

  @UseGuards(AuthGuard)
  @Post(':groupId/members/:userId/promote-moderator')
  async promote(@CurrentUserId() viewerUserId: string, @Param('groupId') groupId: string, @Param('userId') userId: string) {
    return await this.groups.promoteModerator({ viewerUserId, groupId, userId });
  }

  @UseGuards(AuthGuard)
  @Post(':groupId/members/:userId/demote-moderator')
  async demote(@CurrentUserId() viewerUserId: string, @Param('groupId') groupId: string, @Param('userId') userId: string) {
    return await this.groups.demoteModerator({ viewerUserId, groupId, userId });
  }
}
