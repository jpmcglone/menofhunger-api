import { Inject, Injectable, Optional } from "@nestjs/common";
import { startSpan } from "@sentry/nestjs";
import type { Response } from "express";
import type { AuthMeDto } from "../../common/dto/auth.dto";
import {
  totalUserArticlesWhere,
  totalUserPostsWhere,
} from "../../common/content-counts";
import { AuthService } from "./auth.service";
import { ImpersonationService } from "./impersonation.service";
import { AccountSwitchService } from "./account-switch.service";
import { NotificationReadStateService } from "../notifications/notification-read-state.service";
import { MessagesConversationStateService } from "../messages/messages-conversation-state.service";
import { CrewInvitesService } from "../crew/crew-invites.service";
import { GroupInvitesService } from "../groups/group-invites.service";
import { PrismaService } from "../prisma/prisma.service";

const clampCount = (value: unknown): number =>
  Math.max(0, Math.floor(Number(value) || 0));

/**
 * Aggregates the `/auth/me` payload: the session user plus live badge counts.
 * Lives outside AuthModule so it can depend on notifications/messages/crew/groups without cycles.
 */
@Injectable()
export class AuthMeService {
  constructor(
    private readonly auth: AuthService,
    private readonly impersonation: ImpersonationService,
    private readonly accountSwitch: AccountSwitchService,
    @Optional()
    @Inject(NotificationReadStateService)
    private readonly notifications?: Pick<
      NotificationReadStateService,
      "getUndeliveredCount" | "getUnreadCommentCount" | "getGroupsUnread"
    >,
    @Optional()
    @Inject(MessagesConversationStateService)
    private readonly messages?: Pick<
      MessagesConversationStateService,
      "getUnreadSummary"
    >,
    @Optional() private readonly crewInvites?: CrewInvitesService,
    @Optional() private readonly groupInvites?: GroupInvitesService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async me(
    token: string | null | undefined,
    res: Response,
  ): Promise<{ data: AuthMeDto | null }> {
    const sessionResult = await startSpan(
      { name: "auth.me.session", op: "auth.me" },
      () => this.auth.meFromSessionToken(token ?? undefined),
    );
    if (!sessionResult?.user?.id) return { data: null };

    if (sessionResult.renewed && token) {
      this.auth.setSessionCookie(token, sessionResult.expiresAt, res);
    }

    // Run expensive per-request checks (pinned-post validity, streak self-heal) only here,
    // not in every auth guard invocation.
    let { user } = sessionResult;
    if (token) {
      user = await startSpan({ name: "auth.me.checks", op: "auth.me" }, () =>
        this.auth.runMeChecks(token, user.id, user.pinnedPostId ?? null, user),
      );
    }

    const { notifications, messages, crewInvites, groupInvites, prisma } = this;

    const [
      notificationCountRes,
      notificationUnreadCommentCountRes,
      groupsUnreadRes,
      crewInviteInboxCountRes,
      groupInviteInboxCountRes,
      messageCountsRes,
      postCountRes,
      articleCountRes,
      impersonationRes,
      accountSwitchRes,
    ] = await Promise.allSettled([
      startSpan(
        { name: "auth.me.notifications", op: "auth.me" },
        () => notifications?.getUndeliveredCount(user.id) ?? Promise.resolve(0),
      ),
      startSpan(
        { name: "auth.me.unread_comments", op: "auth.me" },
        () =>
          notifications?.getUnreadCommentCount(user.id) ?? Promise.resolve(0),
      ),
      startSpan(
        { name: "auth.me.groups", op: "auth.me" },
        () =>
          notifications?.getGroupsUnread(user.id) ??
          Promise.resolve({ total: 0, byGroupId: {} }),
      ),
      startSpan(
        { name: "auth.me.crew_invites", op: "auth.me" },
        () => crewInvites?.countInboxPending(user.id) ?? Promise.resolve(0),
      ),
      startSpan(
        { name: "auth.me.group_invites", op: "auth.me" },
        () => groupInvites?.countInboxPending(user.id) ?? Promise.resolve(0),
      ),
      startSpan(
        { name: "auth.me.messages", op: "auth.me" },
        () =>
          messages?.getUnreadSummary(user.id) ??
          Promise.resolve({ primary: 0, requests: 0 }),
      ),
      startSpan(
        { name: "auth.me.post_count", op: "auth.me" },
        () =>
          prisma?.post.count({ where: totalUserPostsWhere(user.id) }) ??
          Promise.resolve(null),
      ),
      startSpan(
        { name: "auth.me.article_count", op: "auth.me" },
        () =>
          prisma?.article.count({ where: totalUserArticlesWhere(user.id) }) ??
          Promise.resolve(null),
      ),
      startSpan({ name: "auth.me.impersonation", op: "auth.me" }, () =>
        this.impersonation.describe(sessionResult.impersonatedByUserId),
      ),
      startSpan({ name: "auth.me.account_switch", op: "auth.me" }, () =>
        this.accountSwitch.describe(sessionResult.operatedByUserId),
      ),
    ]);

    const count = (res: PromiseSettledResult<unknown>) =>
      res.status === "fulfilled" ? clampCount(res.value) : 0;
    const nullableCount = (res: PromiseSettledResult<unknown>) =>
      res.status === "fulfilled" && typeof res.value === "number"
        ? Math.max(0, Math.floor(res.value))
        : null;

    const groupsUnread =
      groupsUnreadRes.status === "fulfilled"
        ? {
            total: clampCount(groupsUnreadRes.value?.total),
            byGroupId: Object.fromEntries(
              Object.entries(groupsUnreadRes.value?.byGroupId ?? {}).map(
                ([groupId, n]) => [groupId, clampCount(n)],
              ),
            ),
          }
        : { total: 0, byGroupId: {} };
    const messageUnreadCounts =
      messageCountsRes.status === "fulfilled"
        ? {
            primary: clampCount(messageCountsRes.value?.primary),
            requests: clampCount(messageCountsRes.value?.requests),
          }
        : { primary: 0, requests: 0 };

    return {
      data: {
        ...user,
        notificationUndeliveredCount: count(notificationCountRes),
        notificationUnreadCommentCount: count(
          notificationUnreadCommentCountRes,
        ),
        groupsUnread,
        crewInviteInboxCount: count(crewInviteInboxCountRes),
        groupInviteInboxCount: count(groupInviteInboxCountRes),
        messageUnreadCounts,
        postCount: nullableCount(postCountRes),
        articleCount: nullableCount(articleCountRes),
        impersonation:
          impersonationRes.status === "fulfilled"
            ? (impersonationRes.value ?? null)
            : null,
        accountSwitch:
          accountSwitchRes.status === "fulfilled"
            ? (accountSwitchRes.value ?? null)
            : null,
      },
    };
  }
}
