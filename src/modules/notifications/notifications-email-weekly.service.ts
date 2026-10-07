import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import type { PostVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AppConfigService } from '../app/app-config.service';
import { buildGreeting, getRecipientEmail } from '../email/email-send.helpers';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { MessagesService } from '../messages/messages.service';
import { EMAIL, escapeHtml, renderButton, renderCard, renderMohEmail, renderPill } from '../email/templates/moh-email';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { computeCheckinRewards } from '../checkins/checkin-rewards';
import { CHECKIN_REMINDER_MINUTE } from '../checkins/checkin-schedule';
import { SlackService } from '../../common/slack/slack.service';

import { PostsReadService } from '../posts-read/posts-read.service';

import { NotificationsEmailSupportService } from "./notifications-email-support.service";
import { safeBaseUrl, renderEmailAvatar, easternYmd, easternYmdHm, easternDayKey, easternUtcMsForLocal, truncate } from "./notifications-email.helpers";

@Injectable()
export class NotificationsEmailWeeklyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly appConfig: AppConfigService,
    private readonly jobs: JobsService,
    private readonly messages: MessagesService,
    private readonly slack: SlackService,
    private readonly postsRead: PostsReadService,
    private readonly support: NotificationsEmailSupportService,
  ) {}
  @Cron('*/5 * * * *')
  async sendWeeklyDigest(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    try {
      const now = new Date();
      const et = easternYmdHm(now);
      const minuteOfDay = et.hh * 60 + et.mm;
      // Only enqueue in the 8:00-8:59am ET window.
      if (minuteOfDay < 8 * 60 || minuteOfDay >= 9 * 60) return;
      // Only enqueue on Sundays (ET day-of-week 0).
      const sundayCheck = new Date(Date.UTC(et.y, et.m - 1, et.d));
      if (sundayCheck.getUTCDay() !== 0) return;
      const weekKey = easternDayKey(now); // e.g. "2026-02-22" (the Sunday date)
      await this.jobs.enqueueCron(JOBS.notificationsWeeklyDigest, {}, `cron:notificationsWeeklyDigest:${weekKey}`, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
      });
    } catch {
      // likely duplicate jobId; treat as no-op
    }
  }

  /** Check-in streak reminder (send once per day at 8pm ET with the in-app nudge). */
  @Cron('*/5 * * * *')
  async sendStreakReminderEmail(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    try {
      const now = new Date();
      const et = easternYmdHm(now);
      const minuteOfDay = et.hh * 60 + et.mm;
      if (minuteOfDay < CHECKIN_REMINDER_MINUTE) return;
      const dayKey = easternDayKey(now);
      await this.jobs.enqueueCron(
        JOBS.notificationsStreakReminderEmail,
        { dayKey },
        `cron:notificationsStreakReminderEmail:${dayKey}`,
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5 * 60_000 },
        },
      );
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  async runSendStreakReminderEmail(payload?: { dayKey?: string }): Promise<void> {
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    try {
      const now = new Date();
      const todayKey = easternDayKey(now);
      const scheduledDayKey = String(payload?.dayKey ?? todayKey).trim() || todayKey;
      if (scheduledDayKey !== todayKey) {
        this.support.logger.warn(`[streak-reminder] skipping stale dayKey=${scheduledDayKey}`);
        return;
      }

      const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
      const homeUrl = `${baseUrl}/home?checkin=1`;
      const settingsUrl = `${baseUrl}/settings/notifications`;

      const todayEt = easternYmd(now);
      const dayStartUtc = new Date(easternUtcMsForLocal({ ...todayEt, hh: 0, mm: 0 }));
      const yesterdayKey = easternDayKey(new Date(now.getTime() - 36 * 60 * 60 * 1000));

    type RecipientRow = {
      id: string;
      email: string | null;
      username: string | null;
      name: string | null;
      checkinStreakDays: number;
      notificationPreferences: { emailStreakReminder: boolean; lastEmailStreakReminderSentAt: Date | null } | null;
    };

    let cursorId: string | null = null;
    const pageSize = 400;
    for (;;) {
      const recipients: RecipientRow[] = await this.prisma.user.findMany({
        where: {
          email: { not: null },
          emailVerifiedAt: { not: null },
          accountKind: 'person',
          checkinStreakDays: { gt: 0 },
          ...(cursorId ? { id: { gt: cursorId } } : {}),
          AND: [
            { posts: { some: { kind: 'checkin', checkinDayKey: yesterdayKey, deletedAt: null } } },
            { NOT: { posts: { some: { kind: 'checkin', checkinDayKey: todayKey, deletedAt: null } } } },
            {
              OR: [
                { notificationPreferences: { is: null } },
                { notificationPreferences: { is: { emailStreakReminder: true } } },
              ],
            },
          ],
        },
        orderBy: [{ id: 'asc' }],
        take: pageSize,
        select: {
          id: true,
          email: true,
          username: true,
          name: true,
          checkinStreakDays: true,
          notificationPreferences: { select: { emailStreakReminder: true, lastEmailStreakReminderSentAt: true } },
        },
      });
      if (recipients.length === 0) break;
      cursorId = recipients[recipients.length - 1]?.id ?? null;

      for (const u of recipients) {
        const to = getRecipientEmail(u.email);
        if (!to) continue;
        if (u.notificationPreferences && !u.notificationPreferences.emailStreakReminder) continue;

        const lastSent = u.notificationPreferences?.lastEmailStreakReminderSentAt ?? null;
        if (lastSent && lastSent.getTime() >= dayStartUtc.getTime()) continue;

        const currentStreak = Math.max(0, Math.floor(u.checkinStreakDays ?? 0));
        if (currentStreak <= 0) continue;

        const reward = computeCheckinRewards({
          todayKey,
          yesterdayKey,
          lastCheckinDayKey: yesterdayKey,
          currentStreakDays: currentStreak,
        });

        const greeting = buildGreeting({ name: u.name, username: u.username, tone: 'hey' });

        const subject = `Don’t lose your streak (${currentStreak} day${currentStreak === 1 ? '' : 's'})`;

        const text = [
          greeting,
          '',
          `You’re on a ${currentStreak}-day check-in streak.`,
          `Check in today before midnight ET to keep it.`,
          '',
          `Today’s multiplier: ${reward.multiplier}x (${reward.coinsAdd} coin${reward.coinsAdd === 1 ? '' : 's'} for today’s check-in)`,
          `If you skip today, your streak resets to 0.`,
          '',
          `Open: ${homeUrl}`,
          '',
          `Manage email notification settings: ${settingsUrl}`,
        ].join('\n');

        const html = renderMohEmail({
          title: `Keep your streak`,
          preheader: `Check in today to keep your ${currentStreak}-day streak.`,
          contentHtml: [
            `<div style="font-size:20px;font-weight:900;line-height:1.25;margin:0 0 6px 0;color:${EMAIL.text};">Keep your streak</div>`,
            `<div style="margin:0 0 10px 0;font-size:14px;line-height:1.7;color:${EMAIL.muted};">${escapeHtml(greeting)}</div>`,
            renderCard(
              [
                `<div style="margin-bottom:10px;">${renderPill('Streak reminder', 'warning')}</div>`,
                `<div style="font-size:14px;line-height:1.8;color:${EMAIL.text};">You’re on a <strong>${currentStreak}</strong>-day check-in streak.</div>`,
                `<div style="margin-top:10px;font-size:14px;line-height:1.8;color:${EMAIL.text};">Check in <strong>today</strong> before midnight ET to keep it.</div>`,
                `<div style="margin-top:10px;font-size:13px;line-height:1.7;color:${EMAIL.muted};">Today’s multiplier: <strong style="color:${EMAIL.text};">${reward.multiplier}x</strong> (${reward.coinsAdd} coin${reward.coinsAdd === 1 ? '' : 's'}).</div>`,
                `<div style="margin-top:10px;font-size:13px;line-height:1.7;color:${EMAIL.muted};">If you skip today, your streak resets to 0.</div>`,
                `<div style="margin-top:12px;">${renderButton({ href: homeUrl, label: 'Check in' })}</div>`,
              ].join(''),
            ),
            `<div style="margin-top:16px;font-size:13px;line-height:1.8;color:${EMAIL.muted};">Manage notification settings: <a href="${escapeHtml(
              settingsUrl,
            )}" style="color:${EMAIL.text};text-decoration:underline;">${escapeHtml(settingsUrl)}</a></div>`,
          ].join(''),
          footerHtml: `Manage notifications in <a href="${escapeHtml(
            settingsUrl,
          )}" style="color:${EMAIL.soft};text-decoration:underline;">Settings → Notifications</a> · Men of Hunger`,
        });

        await this.support.sendEmailAndHandle({
          to,
          subject,
          text,
          html,
          userId: u.id,
          logTag: 'streak-reminder',
          onSent: async () => {
            await this.prisma.notificationPreferences.upsert({
              where: { userId: u.id },
              create: { userId: u.id, lastEmailStreakReminderSentAt: now },
              update: { lastEmailStreakReminderSentAt: now },
            });
          },
        });
      }
    }
    } catch (err) {
      this.support.logger.error(
        `[streak-reminder] run failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  async runSendWeeklyDigest(): Promise<void> {
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    try {
      const now = new Date();
      const et = easternYmdHm(now);

      // Only run on Sundays (ET).
      const sundayCheck = new Date(Date.UTC(et.y, et.m - 1, et.d));
      if (sundayCheck.getUTCDay() !== 0) return;

      // Weekly window: last Sunday 8am ET → this Sunday 8am ET (7 days).
      const thisWeekEndUtcMs = easternUtcMsForLocal({ ...easternYmd(now), hh: 8, mm: 0 });
      const lastSundayEt = easternYmd(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
      const lastWeekStartUtcMs = easternUtcMsForLocal({ ...lastSundayEt, hh: 8, mm: 0 });
      const weekWindowStart = new Date(lastWeekStartUtcMs);
      const weekWindowEnd = new Date(thisWeekEndUtcMs);

      const sendStartUtc = weekWindowEnd;
      const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
      const settingsUrl = `${baseUrl}/settings/notifications`;
      const r2PublicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

      // Best post of the week (per-tier): order by trendingScore DESC (NULLS LAST, so unscored posts fall to bottom).
      const weeklyFeaturedSelect = { id: true, body: true, createdAt: true, user: { select: { username: true, name: true } } } satisfies Prisma.PostSelect;
      const weeklyCreatedAtWindow = { gte: weekWindowStart, lt: weekWindowEnd };

      const weeklyFeaturedPostPublic = await this.postsRead.read.findFirst({
        where: { deletedAt: null, parentId: null, kind: { not: 'board' }, visibility: { in: ['public'] }, createdAt: weeklyCreatedAtWindow },
        orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: weeklyFeaturedSelect,
      });
      const weeklyFeaturedPostVerified = await this.postsRead.read.findFirst({
        where: { deletedAt: null, parentId: null, kind: { not: 'board' }, visibility: { in: ['public', 'verifiedOnly'] }, createdAt: weeklyCreatedAtWindow },
        orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: weeklyFeaturedSelect,
      });
      const weeklyFeaturedPostPremium = await this.postsRead.read.findFirst({
        where: { deletedAt: null, parentId: null, kind: { not: 'board' }, visibility: { in: ['public', 'verifiedOnly', 'premiumOnly'] }, createdAt: weeklyCreatedAtWindow },
        orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: weeklyFeaturedSelect,
      });

      const weeklyNewArticleCount = await this.prisma.article.count({
        where: {
          isDraft: false,
          deletedAt: null,
          publishedAt: { gte: weekWindowStart, lt: weekWindowEnd },
        },
      });
      const weeklyTopArticleSelect = {
        id: true,
        title: true,
        excerpt: true,
        publishedAt: true,
        author: { select: { username: true, name: true } },
      } as const;
      const weeklyTopArticlesPublic = await this.prisma.article.findMany({
        where: {
          isDraft: false,
          deletedAt: null,
          visibility: { in: ['public'] },
          publishedAt: { gte: weekWindowStart, lt: weekWindowEnd },
        },
        orderBy: [{ trendingScore: { sort: 'desc', nulls: 'last' } }, { publishedAt: 'desc' }, { id: 'desc' }],
        take: 3,
        select: weeklyTopArticleSelect,
      });
      const weeklyTopArticlesVerified = await this.prisma.article.findMany({
        where: {
          isDraft: false,
          deletedAt: null,
          visibility: { in: ['public', 'verifiedOnly'] },
          publishedAt: { gte: weekWindowStart, lt: weekWindowEnd },
        },
        orderBy: [{ trendingScore: { sort: 'desc', nulls: 'last' } }, { publishedAt: 'desc' }, { id: 'desc' }],
        take: 3,
        select: weeklyTopArticleSelect,
      });
      const weeklyTopArticlesPremium = await this.prisma.article.findMany({
        where: {
          isDraft: false,
          deletedAt: null,
          visibility: { in: ['public', 'verifiedOnly', 'premiumOnly'] },
          publishedAt: { gte: weekWindowStart, lt: weekWindowEnd },
        },
        orderBy: [{ trendingScore: { sort: 'desc', nulls: 'last' } }, { publishedAt: 'desc' }, { id: 'desc' }],
        take: 3,
        select: weeklyTopArticleSelect,
      });

      // Top of the Board (per tier): most points, then comments. Article Board posts are covered by articles.
      const weeklyBoardSelect = {
        id: true,
        boostCount: true,
        commentCount: true,
        boardThread: { select: { title: true, domain: true } },
      } satisfies Prisma.PostSelect;
      const weeklyTopBoardFor = (visibilities: PostVisibility[]) =>
        this.postsRead.read.findMany({
          where: {
            kind: 'board',
            parentId: null,
            articleId: null,
            deletedAt: null,
            isDraft: false,
            visibility: { in: visibilities },
            createdAt: weeklyCreatedAtWindow,
            user: { bannedAt: null },
          },
          orderBy: [{ boostCount: 'desc' }, { commentCount: 'desc' }, { createdAt: 'desc' }],
          take: 3,
          select: weeklyBoardSelect,
        });
      const [weeklyTopBoardPublic, weeklyTopBoardVerified, weeklyTopBoardPremium] = await Promise.all([
        weeklyTopBoardFor(['public']),
        weeklyTopBoardFor(['public', 'verifiedOnly']),
        weeklyTopBoardFor(['public', 'verifiedOnly', 'premiumOnly']),
      ]);
      function pickWeeklyTopBoard(u: { verifiedStatus?: string | null; premium?: boolean | null; premiumPlus?: boolean | null }) {
        const isPremium = Boolean(u.premium || u.premiumPlus);
        const isVerified = (u.verifiedStatus ?? 'none') !== 'none';
        if (isPremium) return weeklyTopBoardPremium;
        if (isVerified) return weeklyTopBoardVerified;
        return weeklyTopBoardPublic;
      }

      function pickWeeklyFeaturedPost(u: { verifiedStatus?: string | null; premium?: boolean | null; premiumPlus?: boolean | null }) {
        const isPremium = Boolean(u.premium || u.premiumPlus);
        const isVerified = (u.verifiedStatus ?? 'none') !== 'none';
        if (isPremium) return weeklyFeaturedPostPremium ?? weeklyFeaturedPostVerified ?? weeklyFeaturedPostPublic;
        if (isVerified) return weeklyFeaturedPostVerified ?? weeklyFeaturedPostPublic;
        return weeklyFeaturedPostPublic;
      }
      function pickWeeklyTopArticles(u: { verifiedStatus?: string | null; premium?: boolean | null; premiumPlus?: boolean | null }) {
        const isPremium = Boolean(u.premium || u.premiumPlus);
        const isVerified = (u.verifiedStatus ?? 'none') !== 'none';
        if (isPremium) return weeklyTopArticlesPremium;
        if (isVerified) return weeklyTopArticlesVerified;
        return weeklyTopArticlesPublic;
      }
      function allowedWeeklyVisibilities(u: { verifiedStatus?: string | null; premium?: boolean | null; premiumPlus?: boolean | null }): PostVisibility[] {
        const isPremium = Boolean(u.premium || u.premiumPlus);
        const isVerified = (u.verifiedStatus ?? 'none') !== 'none';
        if (isPremium) return ['public', 'verifiedOnly', 'premiumOnly'];
        if (isVerified) return ['public', 'verifiedOnly'];
        return ['public'];
      }

      // New members this week — up to 15 shown, with overflow count.
      const weeklyNewMembersUserSelect = {
        id: true,
        username: true,
        name: true,
        avatarKey: true, avatarVideoKey: true, avatarVideoDurationMs: true,
        avatarUpdatedAt: true,
      } as const;
      const weeklyNewMembersTotal = await this.prisma.user.count({
        where: { emailVerifiedAt: { not: null }, bannedAt: null, createdAt: { gte: weekWindowStart, lt: weekWindowEnd } },
      });
      const weeklyNewMembers = await this.prisma.user.findMany({
        where: { emailVerifiedAt: { not: null }, bannedAt: null, createdAt: { gte: weekWindowStart, lt: weekWindowEnd } },
        orderBy: [{ createdAt: 'desc' }],
        take: 15,
        select: weeklyNewMembersUserSelect,
      });

      type WeeklyRecipientRow = {
        id: string;
        email: string | null;
        username: string | null;
        name: string | null;
        verifiedStatus: 'none' | 'identity' | 'manual';
        premium: boolean;
        premiumPlus: boolean;
        notificationPreferences: { emailDigestWeekly: boolean; lastEmailDigestWeeklySentAt: Date | null } | null;
      };

      let cursorId: string | null = null;
      const pageSize = 200;
      for (;;) {
        const recipients: WeeklyRecipientRow[] = await this.prisma.user.findMany({
          where: {
            email: { not: null },
            emailVerifiedAt: { not: null },
            ...(cursorId ? { id: { gt: cursorId } } : {}),
            OR: [
              { notificationPreferences: { is: null } },
              { notificationPreferences: { is: { emailDigestWeekly: true } } },
            ],
          },
          orderBy: [{ id: 'asc' }],
          take: pageSize,
          select: {
            id: true,
            email: true,
            username: true,
            name: true,
            verifiedStatus: true,
            premium: true,
            premiumPlus: true,
            notificationPreferences: { select: { emailDigestWeekly: true, lastEmailDigestWeeklySentAt: true } },
          },
        });

        if (recipients.length === 0) break;
        cursorId = recipients[recipients.length - 1]?.id ?? null;
        const recipientIds = recipients.map((r) => r.id);
        const preferenceRows = recipientIds.length > 0
          ? await this.prisma.userTaxonomyPreference.findMany({
              where: { userId: { in: recipientIds } },
              select: { userId: true, term: { select: { slug: true, label: true } } },
              orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
            })
          : [];
        const preferencesByUser = new Map<string, Array<{ tag: string; label: string }>>();
        for (const row of preferenceRows) {
          const list = preferencesByUser.get(row.userId) ?? [];
          list.push({ tag: row.term.slug, label: row.term.label });
          preferencesByUser.set(row.userId, list);
        }

        for (const u of recipients) {
          const to = getRecipientEmail(u.email);
          if (!to) continue;
          if (u.notificationPreferences && !u.notificationPreferences.emailDigestWeekly) continue;

          const lastSent = u.notificationPreferences?.lastEmailDigestWeeklySentAt ?? null;
          // Skip if already sent this week (within last 6 days).
          if (lastSent && lastSent.getTime() >= sendStartUtc.getTime()) continue;

          const greeting = buildGreeting({ name: u.name, username: u.username, tone: 'morning' });

          const featuredPost = pickWeeklyFeaturedPost(u);
          const featuredUrl = featuredPost ? `${baseUrl}/p/${encodeURIComponent(featuredPost.id)}` : null;
          const topArticles = pickWeeklyTopArticles(u);
          const topBoard = pickWeeklyTopBoard(u);
          const preferredTags = preferencesByUser.get(u.id) ?? [];
          const allowedVis = allowedWeeklyVisibilities(u);
          const seenTaggedArticleIds = new Set<string>();
          const taggedArticleGroups: Array<{
            tag: string;
            label: string;
            articles: typeof topArticles;
            posts: Array<{ id: string; body: string; user: { username: string | null; name: string | null } }>;
          }> = [];
          // Keep weekly email compact: up to 3 tag groups, 2 articles each.
          const prefCandidates = preferredTags.slice(0, 5);
          const prefResults = await Promise.all(prefCandidates.map(async (pref) => {
            const [byTag, topPostsByTerm] = await Promise.all([
              this.prisma.article.findMany({
                where: {
                  isDraft: false,
                  deletedAt: null,
                  visibility: { in: allowedVis },
                  publishedAt: { gte: weekWindowStart, lt: weekWindowEnd },
                  tags: { some: { tag: pref.tag } },
                },
                orderBy: [{ trendingScore: { sort: 'desc', nulls: 'last' } }, { publishedAt: 'desc' }, { id: 'desc' }],
                take: 6,
                select: weeklyTopArticleSelect,
              }),
              this.postsRead.read.findMany({
                where: {
                  deletedAt: null,
                  parentId: null,
                  visibility: { in: allowedVis },
                  createdAt: { gte: weekWindowStart, lt: weekWindowEnd },
                  topics: { has: pref.tag },
                },
                orderBy: [{ boostCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
                take: 1,
                select: {
                  id: true,
                  body: true,
                  user: { select: { username: true, name: true } },
                },
              }),
            ]);
            return { pref, byTag, topPostsByTerm };
          }));
          for (const result of prefResults) {
            if (taggedArticleGroups.length >= 3) break;
            if (!result.byTag.length && result.topPostsByTerm.length === 0) continue;
            const deduped = result.byTag.filter((a) => {
              if (seenTaggedArticleIds.has(a.id)) return false;
              seenTaggedArticleIds.add(a.id);
              return true;
            }).slice(0, 2);
            if (deduped.length > 0 || result.topPostsByTerm.length > 0) {
              taggedArticleGroups.push({
                tag: result.pref.tag,
                label: result.pref.label || result.pref.tag,
                articles: deduped as typeof topArticles,
                posts: result.topPostsByTerm,
              });
            }
          }

          const newMembersBlock =
            weeklyNewMembers.length > 0
              ? renderCard(
                  [
                    `<div style="margin-bottom:10px;">${renderPill(`New this week`, 'success')}</div>`,
                    `<div style="display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;">`,
                    ...weeklyNewMembers.map((m) => {
                      const profileUrl = `${baseUrl}/u/${encodeURIComponent(m.username ?? m.id)}`;
                      const mAvatarUrl = publicAssetUrl({ publicBaseUrl: r2PublicBaseUrl, key: m.avatarKey, updatedAt: m.avatarUpdatedAt });
                      return [
                        `<div style="display:inline-flex;flex-direction:column;align-items:center;gap:5px;text-align:center;width:72px;">`,
                        renderEmailAvatar({ profileUrl, avatarUrl: mAvatarUrl, displayName: m.username ?? m.name ?? '?', size: 44 }),
                        `<a href="${escapeHtml(profileUrl)}" style="font-size:11px;font-weight:700;color:${EMAIL.text};text-decoration:none;max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;">@${escapeHtml((m.username ?? '').trim() || m.id)}</a>`,
                        `</div>`,
                      ].join('');
                    }),
                    `</div>`,
                    weeklyNewMembersTotal > weeklyNewMembers.length
                      ? `<div style="margin-top:10px;font-size:12px;color:${EMAIL.soft};">…and ${weeklyNewMembersTotal - weeklyNewMembers.length} more</div>`
                      : ``,
                  ].join(''),
                )
              : '';

          const featuredHtml = featuredPost
            ? renderCard(
                [
                  `<div style="margin-bottom:10px;">${renderPill('Best post of the week', 'success')}</div>`,
                  `<div style="font-size:13px;line-height:1.7;color:${EMAIL.muted};">by <strong style="color:${EMAIL.text};">@${escapeHtml(
                    (featuredPost.user.username ?? 'unknown').trim(),
                  )}</strong></div>`,
                  `<div style="margin-top:10px;font-size:14px;line-height:1.8;color:${EMAIL.text};">${escapeHtml(
                    truncate(featuredPost.body ?? '', 260),
                  )}</div>`,
                  featuredUrl ? `<div style="margin-top:12px;">${renderButton({ href: featuredUrl, label: 'Open post' })}</div>` : ``,
                ].join(''),
              )
            : '';
          const topArticlesHtml = topArticles.length > 0
            ? renderCard(
                [
                  `<div style="margin-bottom:10px;">${renderPill('Best articles this week', 'success')}</div>`,
                  ...topArticles.map((a, idx) => {
                    const articleUrl = `${baseUrl}/a/${encodeURIComponent(a.id)}`;
                    const authorRealName = (a.author?.name ?? '').trim();
                    const authorUser = (a.author?.username ?? '').trim();
                    const authorDisplay = authorRealName || (authorUser ? `@${authorUser}` : 'Unknown');
                    return [
                      `<div style="${idx > 0 ? `margin-top:10px;padding-top:10px;border-top:1px solid ${EMAIL.border};` : ''}">`,
                      `<a href="${escapeHtml(articleUrl)}" style="font-size:14px;line-height:1.6;color:${EMAIL.text};text-decoration:none;font-weight:700;">${escapeHtml(truncate(a.title ?? 'Untitled article', 140))}</a>`,
                      `<div style="margin-top:4px;font-size:12px;color:${EMAIL.muted};">by ${escapeHtml(authorDisplay)}</div>`,
                      a.excerpt ? `<div style="margin-top:4px;font-size:12px;line-height:1.6;color:${EMAIL.muted};">${escapeHtml(truncate(a.excerpt, 150))}</div>` : '',
                      `</div>`,
                    ].join('');
                  }),
                  `<div style="margin-top:12px;font-size:12px;color:${EMAIL.muted};">${weeklyNewArticleCount} new article${weeklyNewArticleCount === 1 ? '' : 's'} this week</div>`,
                ].join(''),
              )
            : '';
          const boardMeta = (b: (typeof topBoard)[number]) =>
            [
              `${b.boostCount} ${b.boostCount === 1 ? 'point' : 'points'}`,
              `${b.commentCount} ${b.commentCount === 1 ? 'comment' : 'comments'}`,
              b.boardThread?.domain ?? null,
            ].filter(Boolean).join(' · ');
          const topBoardHtml = topBoard.length > 0
            ? renderCard(
                [
                  `<div style="margin-bottom:10px;">${renderPill('Top of the Board', 'info')}</div>`,
                  ...topBoard.map((b, idx) => {
                    const boardUrl = `${baseUrl}/b/${encodeURIComponent(b.id)}`;
                    return [
                      `<div style="${idx > 0 ? `margin-top:10px;padding-top:10px;border-top:1px solid ${EMAIL.border};` : ''}">`,
                      `<a href="${escapeHtml(boardUrl)}" style="font-size:14px;line-height:1.6;color:${EMAIL.text};text-decoration:none;font-weight:700;">${escapeHtml(truncate(b.boardThread?.title ?? 'Board post', 140))}</a>`,
                      `<div style="margin-top:4px;font-size:12px;color:${EMAIL.muted};">${escapeHtml(boardMeta(b))}</div>`,
                      `</div>`,
                    ].join('');
                  }),
                  `<div style="margin-top:12px;">${renderButton({ href: `${baseUrl}/b`, label: 'Open the Board' })}</div>`,
                ].join(''),
              )
            : '';
          const pickedForYouHtml = taggedArticleGroups.length > 0
            ? renderCard(
                [
                  `<div style="margin-bottom:10px;">${renderPill('Picked for you', 'success')}</div>`,
                  ...taggedArticleGroups.map((group, groupIdx) => {
                    const groupLabel = group.label;
                    return [
                      `<div style="${groupIdx > 0 ? `margin-top:12px;padding-top:12px;border-top:1px solid ${EMAIL.border};` : ''}">`,
                      `<div style="font-size:12px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;color:${EMAIL.muted};">${escapeHtml(groupLabel)}</div>`,
                      ...group.articles.map((a, idx) => {
                        const articleUrl = `${baseUrl}/a/${encodeURIComponent(a.id)}`;
                        const authorRealName = (a.author?.name ?? '').trim();
                        const authorUser = (a.author?.username ?? '').trim();
                        const authorDisplay = authorRealName || (authorUser ? `@${authorUser}` : 'Unknown');
                        return [
                          `<div style="${idx > 0 ? `margin-top:8px;padding-top:8px;border-top:1px dashed ${EMAIL.border};` : 'margin-top:6px'}">`,
                          `<a href="${escapeHtml(articleUrl)}" style="font-size:14px;line-height:1.6;color:${EMAIL.text};text-decoration:none;font-weight:700;">${escapeHtml(truncate(a.title ?? 'Untitled article', 120))}</a>`,
                          `<div style="margin-top:4px;font-size:12px;color:${EMAIL.muted};">by ${escapeHtml(authorDisplay)}</div>`,
                          `</div>`,
                        ].join('');
                      }),
                      ...group.posts.map((p) => {
                        const postUrl = `${baseUrl}/p/${encodeURIComponent(p.id)}`;
                        const authorDisplay = (p.user.name ?? '').trim() || ((p.user.username ?? '').trim() ? `@${(p.user.username ?? '').trim()}` : 'Unknown');
                        return [
                          `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed ${EMAIL.border};">`,
                          `<a href="${escapeHtml(postUrl)}" style="font-size:13px;line-height:1.6;color:${EMAIL.text};text-decoration:none;font-weight:700;">Top post this week</a>`,
                          `<div style="margin-top:4px;font-size:12px;color:${EMAIL.muted};">by ${escapeHtml(authorDisplay)}</div>`,
                          `<div style="margin-top:4px;font-size:12px;line-height:1.6;color:${EMAIL.muted};">${escapeHtml(truncate(p.body ?? '', 140))}</div>`,
                          `</div>`,
                        ].join('');
                      }),
                      `</div>`,
                    ].join('');
                  }),
                ].join(''),
              )
            : '';

          const subject = 'Your weekly Men of Hunger digest';

          const textLines: string[] = [
            greeting,
            '',
            'Weekly digest — Men of Hunger',
            '',
          ];
          if (featuredPost) {
            textLines.push(
              'Best post of the week',
              `by @${(featuredPost.user.username ?? 'unknown').trim()}`,
              truncate(featuredPost.body ?? '', 240),
              featuredUrl ? `Open: ${featuredUrl}` : '',
              '',
            );
          }
          if (topArticles.length > 0) {
            textLines.push(
              'Best articles this week',
              ...topArticles.map((a, idx) => {
                const articleUrl = `${baseUrl}/a/${encodeURIComponent(a.id)}`;
                const authorRealName = (a.author?.name ?? '').trim();
                const authorUser = (a.author?.username ?? '').trim();
                const authorDisplay = authorRealName || (authorUser ? `@${authorUser}` : 'Unknown');
                return `${idx + 1}. ${truncate(a.title ?? 'Untitled article', 120)} — ${authorDisplay}\n${articleUrl}`;
              }),
              '',
            );
          }
          if (topBoard.length > 0) {
            textLines.push(
              'Top of the Board',
              ...topBoard.map((b, idx) => `${idx + 1}. ${truncate(b.boardThread?.title ?? 'Board post', 120)} — ${boardMeta(b)}\n${baseUrl}/b/${encodeURIComponent(b.id)}`),
              '',
            );
          }
          if (taggedArticleGroups.length > 0) {
            textLines.push('Picked for you');
            for (const group of taggedArticleGroups) {
              textLines.push(group.label);
              textLines.push(
                ...group.articles.map((a, idx) => {
                  const articleUrl = `${baseUrl}/a/${encodeURIComponent(a.id)}`;
                  const authorRealName = (a.author?.name ?? '').trim();
                  const authorUser = (a.author?.username ?? '').trim();
                  const authorDisplay = authorRealName || (authorUser ? `@${authorUser}` : 'Unknown');
                  return `  ${idx + 1}. ${truncate(a.title ?? 'Untitled article', 120)} — ${authorDisplay}\n  ${articleUrl}`;
                }),
              );
              textLines.push(
                ...group.posts.map((p) => {
                  const postUrl = `${baseUrl}/p/${encodeURIComponent(p.id)}`;
                  const authorDisplay = (p.user.name ?? '').trim() || ((p.user.username ?? '').trim() ? `@${(p.user.username ?? '').trim()}` : 'Unknown');
                  return `  Post: ${truncate(p.body ?? '', 120)} — ${authorDisplay}\n  ${postUrl}`;
                }),
              );
            }
            textLines.push('');
          }
          textLines.push(`New articles this week: ${weeklyNewArticleCount}`);
          if (weeklyNewMembersTotal > 0) {
            textLines.push(
              `New this week: ${weeklyNewMembersTotal} new member${weeklyNewMembersTotal === 1 ? '' : 's'}`,
              ...weeklyNewMembers.map((m) => `  @${(m.username ?? '').trim() || m.id}`),
              weeklyNewMembersTotal > weeklyNewMembers.length ? `  …and ${weeklyNewMembersTotal - weeklyNewMembers.length} more` : '',
              '',
            );
          }
          textLines.push(`Manage notification settings: ${settingsUrl}`);
          const text = textLines.filter((l) => l !== '').join('\n');

          const html = renderMohEmail({
            title: `Weekly digest`,
            preheader: featuredPost
              ? `This week's best post + ${weeklyNewArticleCount} new article${weeklyNewArticleCount === 1 ? '' : 's'}.`
              : `Your weekly Men of Hunger recap (${weeklyNewArticleCount} new articles).`,
            contentHtml: [
              `<div style="font-size:20px;font-weight:900;line-height:1.25;margin:0 0 6px 0;color:${EMAIL.text};">Weekly digest</div>`,
              `<div style="margin:0 0 16px 0;font-size:14px;line-height:1.7;color:${EMAIL.muted};">${escapeHtml(greeting)}</div>`,
              ...(featuredPost ? [featuredHtml] : []),
              ...(taggedArticleGroups.length > 0 ? [pickedForYouHtml] : []),
              ...(topArticles.length > 0 ? [topArticlesHtml] : []),
              ...(topBoard.length > 0 ? [topBoardHtml] : []),
              ...(newMembersBlock ? [newMembersBlock] : []),
              `<div style="margin-top:16px;font-size:13px;line-height:1.8;color:${EMAIL.muted};">Manage notification settings: <a href="${escapeHtml(
                settingsUrl,
              )}" style="color:${EMAIL.text};text-decoration:underline;">${escapeHtml(settingsUrl)}</a></div>`,
            ].join(''),
            footerHtml: `Manage notifications in <a href="${escapeHtml(
              settingsUrl,
            )}" style="color:${EMAIL.soft};text-decoration:underline;">Settings → Notifications</a> · Men of Hunger`,
          });

          await this.support.sendEmailAndHandle({
            to,
            subject,
            text,
            html,
            userId: u.id,
            logTag: 'weekly-digest',
            onSent: async () => {
              await this.prisma.notificationPreferences.upsert({
                where: { userId: u.id },
                create: { userId: u.id, lastEmailDigestWeeklySentAt: now },
                update: { lastEmailDigestWeeklySentAt: now },
              });
            },
          });
        }
      }
    } catch (err) {
      this.support.logger.error(
        `[weekly-digest] run failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

}
