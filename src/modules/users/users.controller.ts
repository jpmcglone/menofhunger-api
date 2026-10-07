import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { AuthGuard } from "../auth/auth.guard";
import { OptionalAuthGuard } from "../auth/optional-auth.guard";
import { CurrentUserId, OptionalCurrentUserId } from "./users.decorator";
import { Throttle } from "@nestjs/throttler";
import { rateLimitLimit, rateLimitTtl } from "../../common/throttling/rate-limit.resolver";
import { UsersDiscoveryService } from './users-discovery.service';
import { UsersPreferencesService } from './users-preferences.service';
import { UsersPublicProfileService } from './users-public-profile.service';
import { UsersMeService } from './users-me.service';

@ApiTags("Profiles & Social")
@Controller("users")
export class UsersController {
  constructor(
    private readonly discovery: UsersDiscoveryService,
    private readonly preferences: UsersPreferencesService,
    private readonly profiles: UsersPublicProfileService,
    private readonly me: UsersMeService,
  ) {}

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: 30,
      ttl: 60_000,
    },
  })
  @Get("username/available")
  usernameAvailable(@Query("username") username: string | undefined) {
    return this.discovery.usernameAvailable(username);
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 120),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get("newest")
  newest(@CurrentUserId() viewerUserId: string, @Query() query: unknown) {
    return this.discovery.newest(viewerUserId, query);
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 60),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get("location-preview")
  locationPreview(@Query() query: unknown) {
    return this.discovery.locationPreview(query);
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 60),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("me/skip-location-prompt")
  skipLocationPrompt(@CurrentUserId() userId: string) {
    return this.discovery.skipLocationPrompt(userId);
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 60),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get("by-location")
  byLocation(@CurrentUserId() viewerUserId: string, @Query() query: unknown) {
    return this.discovery.byLocation(viewerUserId, query);
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Get("me/article-tag-preferences")
  getMyArticleTagPreferences(@CurrentUserId() userId: string) {
    return this.preferences.getMyArticleTagPreferences(userId);
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Put("me/article-tag-preferences")
  setMyArticleTagPreferences(@CurrentUserId() userId: string, @Body() body: unknown) {
    return this.preferences.setMyArticleTagPreferences(userId, body);
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Get("me/taxonomy-preferences")
  getMyTaxonomyPreferences(@CurrentUserId() userId: string) {
    return this.preferences.getMyTaxonomyPreferences(userId);
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Put("me/taxonomy-preferences")
  setMyTaxonomyPreferences(@CurrentUserId() userId: string, @Body() body: unknown) {
    return this.preferences.setMyTaxonomyPreferences(userId, body);
  }

  @UseGuards(AuthGuard)
  @Patch("me/username")
  setMyUsername(@Body() body: unknown, @CurrentUserId() userId: string) {
    return this.me.setMyUsername(body, userId);
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 300),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @UseGuards(OptionalAuthGuard)
  @Post("preview/batch")
  @HttpCode(200)
  userPreviewBatch(@Body() body: unknown) {
    return this.profiles.userPreviewBatch(body);
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 300),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @UseGuards(OptionalAuthGuard)
  @Get(":username/preview")
  userPreview(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param("username") username: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.profiles.userPreview(userId, username, res);
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 300),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 120),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @UseGuards(OptionalAuthGuard)
  @Get(":username/affiliates")
  affiliates(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param("username") username: string,
    @Query() query: unknown,
  ) {
    return this.profiles.affiliates(userId, username, query);
  }

  @Get(":username")
  publicProfile(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param("username") username: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.profiles.publicProfile(userId, username, res);
  }

  @UseGuards(AuthGuard)
  @Patch("me/profile")
  updateMyProfile(@Body() body: unknown, @CurrentUserId() userId: string) {
    return this.me.updateMyProfile(body, userId);
  }

  @UseGuards(AuthGuard)
  @Put("me/pinned-post")
  setPinnedPost(@Body() body: unknown, @CurrentUserId() userId: string) {
    return this.me.setPinnedPost(body, userId);
  }

  @UseGuards(AuthGuard)
  @Delete("me/pinned-post")
  unpinPost(@CurrentUserId() userId: string) {
    return this.me.unpinPost(userId);
  }

  @UseGuards(AuthGuard)
  @Patch("me/settings")
  updateMySettings(@Body() body: unknown, @CurrentUserId() userId: string) {
    return this.preferences.updateMySettings(body, userId);
  }

  @UseGuards(AuthGuard)
  @Patch("me/onboarding")
  updateMyOnboarding(@Body() body: unknown, @CurrentUserId() userId: string) {
    return this.me.updateMyOnboarding(body, userId);
  }
}
