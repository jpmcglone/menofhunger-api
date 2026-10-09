import { USER_BRIEF_SELECT } from '../../common/prisma-selects/user.select';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AppConfigService } from '../app/app-config.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { SlackService } from '../../common/slack/slack.service';
import { easternDayKey, easternMinuteOfDay } from '../../common/time/eastern-day-key';
import { adminDigestActivityWindow } from './admin-digest-window';
import { PostsReadService } from '../posts-read/posts-read.service';
import { buildHtml, buildText, safeBaseUrl } from './admin-digest-email.template';
import { NOT_DELETED } from '../../common/prisma/where';

@Injectable()
export class AdminDailyDigestCron {
  private readonly logger = new Logger(AdminDailyDigestCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly appConfig: AppConfigService,
    private readonly jobs: JobsService,
    private readonly slack: SlackService,
    private readonly postsRead: PostsReadService,
  ) {}

  /** Every 5 min: enqueue in the 8:00–8:59am ET window (same hour as user digest). */
  @Cron('*/5 * * * *')
  async sendAdminDailyDigest(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    if (!this.appConfig.email()) return;

    const now = new Date();
    const minuteOfDay = easternMinuteOfDay(now);
    if (minuteOfDay < 8 * 60 || minuteOfDay >= 9 * 60) return;

    const dayKey = easternDayKey(now);
    try {
      await this.jobs.enqueueCron(JOBS.adminDailyDigest, {}, `cron:adminDailyDigest:${dayKey}`, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
      });
    } catch {
      // Duplicate job ID = already enqueued for today; safe to swallow.
    }
  }

  async runSendAdminDailyDigest(): Promise<void> {
    const emailCfg = this.appConfig.email();
    if (!emailCfg && !this.slack.isConfigured) return;

    const now = new Date();
    const dayKey = easternDayKey(now);

    try {
      // DB-level idempotency guard.
      const alreadySent = await this.prisma.adminEmailLog.findUnique({
        where: { kind_dayKey: { kind: 'daily_digest', dayKey } },
      });
      if (alreadySent) {
        this.logger.debug(`Admin daily digest already sent for ${dayKey}; skipping.`);
        return;
      }

      const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
      const { windowStart, windowEnd, sevenDaysAgo, dateLabel } = adminDigestActivityWindow(now);

      // Gather all metrics in parallel.
      const [
        // New members
        newUsers,
        totalNewUserCount,
        totalUserCount,
        // Content activity
        newFeedbackCount,
        newReportCount,
        newPostCount,
        newReplyCount,
        newArticleCount,
        activeUserCount,
        wauCount,
        bannedUserCount,
        // Users who posted (distinct creators)
        usersWhoPostedRows,
        // Open backlog (all-time)
        pendingReportCount,
        unreviewedFeedbackCount,
        pendingVerificationCount,
        // Revenue / subscriptions
        activePremiumCount,
        activePremiumPlusCount,
        pendingCancellationCount,
        newSubscriberRows,
        // Admin recipients
        admins,
      ] = await Promise.all([
        this.prisma.user.findMany({
          where: { createdAt: { gte: windowStart, lt: windowEnd } },
          select: {
            ...USER_BRIEF_SELECT,
            email: true,
            premium: true,
            premiumPlus: true,
            verifiedStatus: true,
            isOrganization: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
          take: 15,
        }),
        this.prisma.user.count({ where: { createdAt: { gte: windowStart, lt: windowEnd } } }),
        // All-time total user count — the baseline for contextualizing daily growth
        this.prisma.user.count({}),
        this.prisma.feedback.count({ where: { createdAt: { gte: windowStart, lt: windowEnd } } }),
        this.prisma.report.count({ where: { createdAt: { gte: windowStart, lt: windowEnd } } }),
        // Top-level posts only (parentId: null); replies counted separately. Board is its own line.
        this.postsRead.count({
          where: { createdAt: { gte: windowStart, lt: windowEnd }, ...NOT_DELETED, isDraft: false, parentId: null, kind: { not: 'board' } },
        }),
        // Replies / comments (Board comments counted separately)
        this.postsRead.count({
          where: { createdAt: { gte: windowStart, lt: windowEnd }, ...NOT_DELETED, isDraft: false, parentId: { not: null }, kind: { not: 'board' } },
        }),
        this.prisma.article.count({
          where: { publishedAt: { gte: windowStart, lt: windowEnd }, ...NOT_DELETED, isDraft: false },
        }),
        // Daily active users (lastSeenAt in window)
        this.prisma.user.count({ where: { lastSeenAt: { gte: windowStart, lt: windowEnd } } }),
        // Weekly active users (7-day) — steadier trend signal than a single day
        this.prisma.user.count({ where: { lastSeenAt: { gte: sevenDaysAgo, lt: windowEnd } } }),
        this.prisma.user.count({ where: { bannedAt: { gte: windowStart, lt: windowEnd } } }),
        // Distinct users who published at least one top-level post yesterday
        this.postsRead.distinctAuthors({ createdAt: { gte: windowStart, lt: windowEnd }, ...NOT_DELETED, isDraft: false, parentId: null, kind: { not: 'board' } }),
        this.prisma.report.count({ where: { status: 'pending' } }),
        this.prisma.feedback.count({ where: { status: 'new' } }),
        this.prisma.verificationRequest.count({ where: { status: 'pending' } }),
        // Active premium subscribers (exclusive: premiumPlus is counted separately)
        this.prisma.user.count({
          where: { premium: true, premiumPlus: false, stripeSubscriptionStatus: 'active' },
        }),
        this.prisma.user.count({
          where: { premiumPlus: true, stripeSubscriptionStatus: 'active' },
        }),
        // Subscribers who will cancel at period end
        this.prisma.user.count({
          where: {
            stripeCancelAtPeriodEnd: true,
            stripeSubscriptionStatus: { in: ['active', 'trialing'] },
          },
        }),
        // New subscriptions that started yesterday (stripeCurrentPeriodStart populated by billing.service)
        this.prisma.user.findMany({
          where: {
            stripeCurrentPeriodStart: { gte: windowStart, lt: windowEnd },
            stripeSubscriptionStatus: { in: ['active', 'trialing'] },
          },
          select: {
            ...USER_BRIEF_SELECT,
            premium: true,
            premiumPlus: true,
            verifiedStatus: true,
            isOrganization: true,
            stripeSubscriptionPriceId: true,
          },
        }),
        // Site admins with verified email
        this.prisma.user.findMany({
          where: { siteAdmin: true, email: { not: null }, emailVerifiedAt: { not: null } },
          select: { id: true, email: true, name: true, username: true },
        }),
      ]);

      const boardWindow = { createdAt: { gte: windowStart, lt: windowEnd }, ...NOT_DELETED, isDraft: false, kind: 'board' as const };
      const [newBoardThreadCount, newBoardCommentCount] = await Promise.all([
        this.postsRead.count({ where: { ...boardWindow, parentId: null } }),
        this.postsRead.count({ where: { ...boardWindow, parentId: { not: null } } }),
      ]);

      // Top post of yesterday: highest trendingScore among top-level posts created in window (admins see all).
      type TopPostRow = {
        id: string;
        body: string;
        boostCount: number;
        commentCount: number;
        viewerCount: number;
        totalViewCount: number;
        username: string | null;
        name: string | null;
        visibility: string;
      };
      let topPost: TopPostRow | null = null;
      {
        const rawPost = await this.postsRead.findFirst({
          where: { ...NOT_DELETED, parentId: null, kind: { not: 'board' }, createdAt: { gte: windowStart, lt: windowEnd }, trendingScore: { gt: 0 } },
          orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, body: true, boostCount: true, commentCount: true, viewerCount: true, totalViewCount: true, visibility: true, user: { select: { username: true, name: true } } },
        }) as { id: string; body: string | null; boostCount: number; commentCount: number; viewerCount: number; totalViewCount: number; visibility: string; user: { username: string | null; name: string | null } | null } | null;

        if (rawPost && !rawPost.body?.trim()?.startsWith('[deleted]')) {
          topPost = {
            id: rawPost.id,
            body: rawPost.body ?? '',
            boostCount: rawPost.boostCount,
            commentCount: rawPost.commentCount,
            viewerCount: rawPost.viewerCount,
            totalViewCount: rawPost.totalViewCount ?? rawPost.viewerCount,
            visibility: rawPost.visibility,
            username: rawPost.user?.username ?? null,
            name: rawPost.user?.name ?? null,
          };
        }
      }
      type TopArticleRow = {
        id: string;
        title: string;
        excerpt: string | null;
        boostCount: number;
        commentCount: number;
        viewCount: number;
        totalViewCount: number;
        username: string | null;
      };
      const topArticlesRaw = await this.prisma.article.findMany({
        where: {
          isDraft: false,
          ...NOT_DELETED,
          publishedAt: { gte: windowStart, lt: windowEnd },
        },
        orderBy: [{ trendingScore: { sort: 'desc', nulls: 'last' } }, { publishedAt: 'desc' }, { id: 'desc' }],
        take: 3,
        select: {
          id: true,
          title: true,
          excerpt: true,
          boostCount: true,
          commentCount: true,
          viewCount: true,
          totalViewCount: true,
          author: { select: { username: true } },
        },
      });
      const topArticles: TopArticleRow[] = topArticlesRaw.map((a) => ({
        id: a.id,
        title: a.title ?? '',
        excerpt: a.excerpt ?? null,
        boostCount: a.boostCount,
        commentCount: a.commentCount,
        viewCount: a.viewCount,
        totalViewCount: a.totalViewCount ?? a.viewCount,
        username: a.author?.username ?? null,
      }));

      const usersWhoPostedCount = usersWhoPostedRows.length;

      // Skip send if there's nothing at all to report.
      const totalActiveSubs = activePremiumCount + activePremiumPlusCount;
      const hasAnything =
        totalNewUserCount > 0 ||
        newFeedbackCount > 0 ||
        newReportCount > 0 ||
        newPostCount > 0 ||
        newArticleCount > 0 ||
        newBoardThreadCount > 0 ||
        newBoardCommentCount > 0 ||
        pendingReportCount > 0 ||
        unreviewedFeedbackCount > 0 ||
        pendingVerificationCount > 0 ||
        bannedUserCount > 0 ||
        totalActiveSubs > 0 ||
        newSubscriberRows.length > 0 ||
        topPost !== null ||
        topArticles.length > 0;

      if (!hasAnything) {
        this.logger.log(`Admin daily digest (${dayKey}): nothing to report — skipping email.`);
        await this.prisma.adminEmailLog.create({ data: { kind: 'daily_digest', dayKey } }).catch(() => {});
        return;
      }

      // Slack digest (fires regardless of email configuration).
      this.slack.notifyDailyDigest({
        dateLabel,
        totalNewUserCount,
        totalUserCount,
        newPostCount,
        newReplyCount,
        usersWhoPostedCount,
        newArticleCount,
        newBoardThreadCount,
        newBoardCommentCount,
        activeUserCount,
        wauCount,
        bannedUserCount,
        activePremiumCount,
        activePremiumPlusCount,
        newSubscriberCount: newSubscriberRows.length,
        pendingCancellationCount,
        pendingReportCount,
        unreviewedFeedbackCount,
        pendingVerificationCount,
        topPost: topPost
          ? {
              id: topPost.id,
              body: topPost.body,
              boostCount: topPost.boostCount,
              commentCount: topPost.commentCount,
              viewerCount: topPost.viewerCount,
              totalViewCount: topPost.totalViewCount,
              username: topPost.username,
            }
          : null,
        topArticles: topArticles.length > 0
          ? topArticles.map((a) => ({
              id: a.id,
              title: a.title,
              boostCount: a.boostCount,
              commentCount: a.commentCount,
              viewCount: a.viewCount,
              totalViewCount: a.totalViewCount,
              username: a.username,
            }))
          : [],
        frontendBaseUrl: baseUrl,
      });

      // Email digest (only if email is configured and admins have verified emails).
      if (emailCfg) {
        const validAdmins = admins.filter((a) => !!a.email);
        if (validAdmins.length === 0) {
          this.logger.warn('Admin daily digest: no site admins with a verified email — cannot send email.');
        } else {
          const html = buildHtml({
            dateLabel,
            now,
            baseUrl,
            newUsers,
            totalNewUserCount,
            totalUserCount,
            newFeedbackCount,
            newReportCount,
            newPostCount,
            newReplyCount,
            usersWhoPostedCount,
            newArticleCount,
            newBoardThreadCount,
            newBoardCommentCount,
            activeUserCount,
            wauCount,
            bannedUserCount,
            pendingReportCount,
            unreviewedFeedbackCount,
            pendingVerificationCount,
            activePremiumCount,
            activePremiumPlusCount,
            pendingCancellationCount,
            newSubscriberRows,
            topPost,
            topArticles,
          });

          const text = buildText({
            dateLabel,
            totalNewUserCount,
            totalUserCount,
            newFeedbackCount,
            newReportCount,
            newPostCount,
            newReplyCount,
            usersWhoPostedCount,
            newArticleCount,
            newBoardThreadCount,
            newBoardCommentCount,
            activeUserCount,
            wauCount,
            bannedUserCount,
            pendingReportCount,
            unreviewedFeedbackCount,
            pendingVerificationCount,
            activePremiumCount,
            activePremiumPlusCount,
            pendingCancellationCount,
            newSubscriberCount: newSubscriberRows.length,
            topPost,
            topArticles,
            baseUrl,
          });

          const subject = `Admin Digest — ${dateLabel}`;
          let sentCount = 0;
          for (const admin of validAdmins) {
            const res = await this.email.sendEmail({ to: admin.email!, subject, text, html, category: 'transactional' });
            if (res.sent) sentCount++;
            else this.logger.warn(`Admin daily digest: failed to send to ${admin.email}`);
          }
          this.logger.log(`Admin daily digest (${dayKey}) sent to ${sentCount}/${validAdmins.length} admin(s).`);
        }
      }

      await this.prisma.adminEmailLog.create({ data: { kind: 'daily_digest', dayKey } }).catch(() => {});
      this.logger.log(`Admin daily digest (${dayKey}) complete.`);
    } catch (err) {
      this.logger.error(
        `Admin daily digest failed: ${(err as Error)?.message ?? String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }
  }

  // ─── HTML ─────────────────────────────────────────────────────────────────

  // ─── Plain-text fallback ──────────────────────────────────────────────────

}
