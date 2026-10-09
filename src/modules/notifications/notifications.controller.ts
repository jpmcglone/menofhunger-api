import { NotificationQueryService } from "./notification-query.service";
import { NotificationReadStateService } from "./notification-read-state.service";
import { NotificationPushService } from "./notification-push.service";
import { ApnsPushService } from "./apns-push.service";
import { NotificationPreferencesService } from "./notification-preferences.service";
import { NotificationReadSubjectsService } from "./notification-read-subjects.service";
import { NotificationNudgesService } from "./notification-nudges.service";
import { preferencesPatchSchema } from "./notification-preferences.schema";
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  Inject,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { AuthGuard } from "../auth/auth-public-api";
import {
  CurrentOperatorUserId,
  CurrentUserId,
  IsImpersonating,
} from "../users/users.decorator";
import {
  rateLimitLimit,
  rateLimitTtl,
} from "../../common/throttling/rate-limit.resolver";
import type { NotificationPreferencesDto } from "../../common/dto";
import {
  listQuerySchema,
  lockScreenClearBodySchema,
  markReadBodySchema,
  pushSubscribeBodySchema,
  pushUnsubscribeBodySchema,
  apnsRegisterBodySchema,
  apnsUnregisterBodySchema,
} from "./notifications.schemas";

@Controller("notifications")
export class NotificationsController {
  constructor(
    @Inject(NotificationQueryService)
    private readonly notificationQueryService: Pick<
      NotificationQueryService,
      "listNewPostsFeed" | "list"
    >,
    @Inject(NotificationReadStateService)
    private readonly notificationReadStateService: Pick<
      NotificationReadStateService,
      | "getUndeliveredCount"
      | "getUnreadCommentCount"
      | "getNavUnread"
      | "markDelivered"
      | "dispatchLockScreenClear"
      | "markNewPostsRead"
      | "markReadByFilter"
      | "markAllRead"
      | "getGroupsUnread"
      | "markGroupPostsDelivered"
      | "markReadById"
      | "ignoreById"
      | "markReadByKind"
    >,
    @Inject(NotificationPushService)
    private readonly notificationPushService: Pick<
      NotificationPushService,
      "pushSubscribe" | "sendTestPush" | "pushUnsubscribe"
    >,
    private readonly apnsPushService: ApnsPushService,
    @Inject(NotificationPreferencesService)
    private readonly notificationPreferencesService: Pick<
      NotificationPreferencesService,
      "getPreferences" | "updatePreferences"
    >,
    @Inject(NotificationReadSubjectsService)
    private readonly notificationReadSubjectsService: Pick<
      NotificationReadSubjectsService,
      "markReadBySubject"
    >,
    @Inject(NotificationNudgesService)
    private readonly notificationNudgesService: Pick<
      NotificationNudgesService,
      | "markNudgesReadByActor"
      | "markNudgesNudgedBackByActor"
      | "markNudgeNudgedBackById"
      | "ignoreNudgesByActor"
    >,
  ) {}

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 240),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get("new-posts")
  async listNewPosts(@CurrentUserId() userId: string, @Query() query: unknown) {
    const parsed = listQuerySchema.parse(query);
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const res = await this.notificationQueryService.listNewPostsFeed({
      recipientUserId: userId,
      limit,
      cursor,
      collapseByRoot: parsed.collapseByRoot ?? false,
      collapseMode: parsed.collapseMode ?? "root",
      prefer: parsed.prefer ?? "reply",
    });
    return {
      data: res.posts,
      pagination: {
        nextCursor: res.nextCursor,
      },
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 240),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get("unread-count")
  async unreadCount(@CurrentUserId() userId: string) {
    const [count, unreadCommentCount, navUnread] = await Promise.all([
      this.notificationReadStateService.getUndeliveredCount(userId),
      this.notificationReadStateService.getUnreadCommentCount(userId),
      this.notificationReadStateService.getNavUnread(userId),
    ]);
    return { data: { count, unreadCommentCount, ...navUnread } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 240),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get()
  async list(@CurrentUserId() userId: string, @Query() query: unknown) {
    const parsed = listQuerySchema.parse(query);
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const res = await this.notificationQueryService.list({
      recipientUserId: userId,
      limit,
      cursor,
      kind: parsed.kind,
      unreadOnly: parsed.unreadOnly,
      boardCommentsOnly: parsed.boardCommentsOnly,
    });
    return {
      data: res.items,
      pagination: {
        nextCursor: res.nextCursor,
        undeliveredCount: res.undeliveredCount,
        unreadByKind: res.unreadByKind,
        unreadByCategory: res.unreadByCategory,
      },
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("push-subscribe")
  async pushSubscribe(
    @CurrentOperatorUserId() operatorUserId: string | null,
    @Body() body: unknown,
  ) {
    if (!operatorUserId) return { data: {} };
    const parsed = pushSubscribeBodySchema.parse(body);
    await this.notificationPushService.pushSubscribe(operatorUserId, {
      endpoint: parsed.endpoint,
      keys: parsed.keys,
      userAgent: parsed.user_agent ?? null,
    });
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 30),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("push-test")
  async pushTest(@CurrentUserId() userId: string) {
    const result = await this.notificationPushService.sendTestPush(userId);
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("push-unsubscribe")
  async pushUnsubscribe(
    @CurrentOperatorUserId() operatorUserId: string | null,
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const parsed = pushUnsubscribeBodySchema.parse(body);
    await this.notificationPushService.pushUnsubscribe(
      operatorUserId ?? userId,
      parsed.endpoint,
    );
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("apns/register")
  async apnsRegister(
    @CurrentOperatorUserId() operatorUserId: string | null,
    @IsImpersonating() isImpersonating: boolean,
    @Body() body: unknown,
  ) {
    const parsed = apnsRegisterBodySchema.parse(body);
    // A device token is unique per device, so registering rebinds it away from whoever
    // held it before. That is correct for a real account switch and wrong for
    // impersonation: it would hand the admin's phone to the target, sending the target's
    // pushes to the admin and silencing the admin's own — and it would outlive the session.
    if (isImpersonating || !operatorUserId) return { data: {} };
    await this.apnsPushService.registerToken(operatorUserId, {
      token: parsed.token,
      environment: parsed.environment ?? "production",
      kind: parsed.kind ?? "alert",
    });
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("apns/unregister")
  async apnsUnregister(
    @CurrentOperatorUserId() operatorUserId: string | null,
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const parsed = apnsUnregisterBodySchema.parse(body);
    await this.apnsPushService.unregisterToken(
      operatorUserId ?? userId,
      parsed.token,
    );
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Get("preferences")
  async preferences(
    @CurrentUserId() userId: string,
  ): Promise<{ data: NotificationPreferencesDto }> {
    return {
      data: await this.notificationPreferencesService.getPreferences(userId),
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Patch("preferences")
  async updatePreferences(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ): Promise<{ data: NotificationPreferencesDto }> {
    const parsed = preferencesPatchSchema.parse(body);
    return {
      data: await this.notificationPreferencesService.updatePreferences(
        userId,
        parsed,
      ),
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("mark-delivered")
  async markDelivered(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = z
      .object({ filter: z.literal("board").optional() })
      .parse(body ?? {});
    await this.notificationReadStateService.markDelivered(
      userId,
      parsed.filter,
    );
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("lock-screen/clear")
  async clearLockScreen(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const parsed = lockScreenClearBodySchema.parse(body);
    this.notificationReadStateService.dispatchLockScreenClear(
      userId,
      parsed.section,
    );
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("new-posts/mark-read")
  async markNewPostsRead(@CurrentUserId() userId: string) {
    const data =
      await this.notificationReadStateService.markNewPostsRead(userId);
    return { data };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("mark-read")
  async markReadBySubject(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const parsed = markReadBodySchema.parse(body);
    if (parsed.filter) {
      await this.notificationReadStateService.markReadByFilter(
        userId,
        parsed.filter,
      );
      return { data: {} };
    }
    await this.notificationReadSubjectsService.markReadBySubject(userId, {
      postId: parsed.post_id ?? null,
      userId: parsed.user_id ?? null,
      articleId: parsed.article_id ?? null,
      crewId: parsed.crew_id ?? null,
      groupId: parsed.group_id ?? null,
      boardThreadId: parsed.board_thread_id ?? null,
    });
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("mark-all-read")
  async markAllRead(@CurrentUserId() userId: string) {
    await this.notificationReadStateService.markAllRead(userId);
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 240),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get("groups-unread")
  async groupsUnread(@CurrentUserId() userId: string) {
    const data =
      await this.notificationReadStateService.getGroupsUnread(userId);
    return { data };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("groups/:groupId/mark-delivered")
  async markGroupPostsDelivered(
    @CurrentUserId() userId: string,
    @Param("groupId") groupId: string,
    @Body() body: unknown,
  ) {
    const gid = (groupId ?? "").trim();
    if (!gid) return { data: {} };
    const parsed = z
      .object({ through: z.string().datetime().optional() })
      .parse(body ?? {});
    const through = parsed.through
      ? new Date(Math.min(Date.parse(parsed.through), Date.now()))
      : undefined;
    await this.notificationReadStateService.markGroupPostsDelivered(
      userId,
      gid,
      through,
    );
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post(":id/mark-read")
  async markReadById(@CurrentUserId() userId: string, @Param("id") id: string) {
    const updated = await this.notificationReadStateService.markReadById(
      userId,
      id,
    );
    return { data: { updated } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post(":id/ignore")
  async ignoreById(@CurrentUserId() userId: string, @Param("id") id: string) {
    const updated = await this.notificationReadStateService.ignoreById(
      userId,
      id,
    );
    return { data: { updated } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("mark-read-by-kind")
  async markReadByKind(@CurrentUserId() userId: string, @Body() body: unknown) {
    const { kind } = z
      .object({
        kind: z.enum([
          "word_of_the_day",
          "quote_of_the_day",
          "checkin_reminder",
          "on_this_day",
        ]),
      })
      .parse(body);
    await this.notificationReadStateService.markReadByKind(userId, kind);
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("nudges/:actorUserId/mark-read")
  async markNudgesReadByActor(
    @CurrentUserId() userId: string,
    @Param("actorUserId") actorUserId: string,
  ) {
    const updatedCount =
      await this.notificationNudgesService.markNudgesReadByActor(
        userId,
        actorUserId,
      );
    return { data: { updatedCount } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("nudges/:actorUserId/nudged-back")
  async markNudgesNudgedBackByActor(
    @CurrentUserId() userId: string,
    @Param("actorUserId") actorUserId: string,
  ) {
    const updatedCount =
      await this.notificationNudgesService.markNudgesNudgedBackByActor(
        userId,
        actorUserId,
      );
    return { data: { updatedCount } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post(":id/nudged-back")
  async markNudgeNudgedBackById(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
  ) {
    const updated =
      await this.notificationNudgesService.markNudgeNudgedBackById(userId, id);
    return { data: { updated } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("nudges/:actorUserId/ignore")
  async ignoreNudgesByActor(
    @CurrentUserId() userId: string,
    @Param("actorUserId") actorUserId: string,
  ) {
    const updatedCount =
      await this.notificationNudgesService.ignoreNudgesByActor(
        userId,
        actorUserId,
      );
    return { data: { updatedCount } };
  }
}
