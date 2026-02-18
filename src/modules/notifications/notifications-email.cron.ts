import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AppConfigService } from '../app/app-config.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { DailyContentService } from '../daily-content/daily-content.service';
import { MessagesService } from '../messages/messages.service';
import { escapeHtml, renderButton, renderCard, renderMohEmail, renderPill } from '../email/templates/moh-email';
import { CHECKIN_PROMPTS } from '../checkins/checkin-prompts';
import { dayIndexEastern, easternDayKey as easternDayKey2 } from '../../common/time/eastern-day-key';
import { computeCheckinRewards } from '../checkins/checkin-rewards';

function safeBaseUrl(raw: string | null): string {
  const base = (raw ?? '').trim() || 'https://menofhunger.com';
  return base.replace(/\/$/, '');
}

const ET_ZONE = 'America/New_York';

function easternYmd(d: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = Number(parts.find((p) => p.type === 'year')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'month')?.value ?? 1);
  const dd = Number(parts.find((p) => p.type === 'day')?.value ?? 1);
  return { y, m, d: dd };
}

function easternYmdHm(d: Date): { y: number; m: number; d: number; hh: number; mm: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const y = Number(parts.find((p) => p.type === 'year')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'month')?.value ?? 1);
  const dd = Number(parts.find((p) => p.type === 'day')?.value ?? 1);
  // Some Intl implementations can emit "24" for midnight with 24-hour formatting.
  // Normalize so minute-of-day checks always treat midnight as 00:xx.
  const hhRaw = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const hh = Number.isFinite(hhRaw) ? ((hhRaw % 24) + 24) % 24 : 0;
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return { y, m, d: dd, hh, mm };
}

function easternDayKey(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

function easternUtcMsForLocal(params: { y: number; m: number; d: number; hh: number; mm: number }): number {
  for (let utcHour = 0; utcHour <= 23; utcHour++) {
    const cand = new Date(Date.UTC(params.y, params.m - 1, params.d, utcHour, params.mm, 0));
    const p = easternYmdHm(cand);
    if (p.y === params.y && p.m === params.m && p.d === params.d && p.hh === params.hh && p.mm === params.mm) {
      return cand.getTime();
    }
  }
  // Fallback: should never happen (8am ET always exists).
  return Date.now();
}

function truncate(s: string, max: number): string {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function pickDailyCheckinPrompt(now: Date): { dayKey: string; prompt: string } {
  const list = CHECKIN_PROMPTS.filter(Boolean);
  const fallback = "How are you doing today?";
  const dayKey = easternDayKey2(now);
  if (list.length === 0) return { dayKey, prompt: fallback };

  const dayIndex = dayIndexEastern(now) + 1;
  const i = ((dayIndex % list.length) + list.length) % list.length;
  return { dayKey, prompt: list[i] ?? fallback };
}

@Injectable()
export class NotificationsEmailCron {
  private readonly logger = new Logger(NotificationsEmailCron.name);

  private readonly INSTANT_EMAIL_DELAY_MS = 2 * 60_000;
  private readonly INSTANT_EMAIL_COOLDOWN_MS = 15 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly appConfig: AppConfigService,
    private readonly jobs: JobsService,
    private readonly dailyContent: DailyContentService,
    private readonly messages: MessagesService,
  ) {}

  /** Every 15 minutes: if you have undelivered notifications, send a lightweight nudge email (if enabled). */
  @Cron('*/15 * * * *')
  async sendNewNotificationsNudges(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    try {
      await this.jobs.enqueueCron(JOBS.notificationsEmailNudges, {}, 'cron:notificationsEmailNudges', {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  async runSendNewNotificationsNudges(): Promise<void> {
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    const now = new Date();
    const cutoff = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
    const notificationsUrl = `${baseUrl}/notifications`;

    // Important: users may not have a NotificationPreferences row yet.
    // Treat "no row" as defaults-on, and upsert the timestamp after sending.
    const recipients = await this.prisma.user.findMany({
      where: {
        email: { not: null },
        emailVerifiedAt: { not: null },
        undeliveredNotificationCount: { gt: 0 },
        OR: [
          // No preferences row yet → defaults apply → eligible.
          { notificationPreferences: { is: null } },
          // Preferences row exists → only if nudges enabled and not recently sent.
          {
            notificationPreferences: {
              is: {
                emailNewNotifications: true,
                OR: [{ lastEmailNewNotificationsSentAt: null }, { lastEmailNewNotificationsSentAt: { lt: cutoff } }],
              },
            },
          },
        ],
      },
      orderBy: [{ id: 'asc' }],
      take: 500,
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        undeliveredNotificationCount: true,
      },
    });

    for (const u of recipients) {
      const to = (u.email ?? '').trim();
      if (!to) continue;

      const undelivered = Math.max(0, Math.floor(u.undeliveredNotificationCount ?? 0));
      if (undelivered <= 0) continue;

      const recent = await this.prisma.notification.findMany({
        where: { recipientUserId: u.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
        select: { title: true, body: true, subjectPostId: true },
      });

      const recentItems = recent
        .map((n) => {
          const title = (n.title ?? 'New notification').trim();
          const body = (n.body ?? '').trim();
          const text = `${title}${body ? ` — ${body}` : ''}`.trim();
          const href = n.subjectPostId ? `${baseUrl}/p/${encodeURIComponent(n.subjectPostId)}` : notificationsUrl;
          return { text, href };
        })
        .filter((x) => Boolean(x.text));

      const lines = recentItems.map((it) => {
        // Keep plain text concise; only include a direct link when we have a specific destination.
        const direct = it.href !== notificationsUrl ? ` (${it.href})` : '';
        return `- ${it.text}${direct}`;
      });

      const greetingName = (u.name ?? u.username ?? '').trim();
      const greeting = greetingName ? `Hey ${greetingName},` : `Hey,`;

      const text = [
        greeting,
        '',
        `You have ${undelivered} new notification${undelivered === 1 ? '' : 's'} on Men of Hunger.`,
        '',
        ...(lines.length ? ['Recent:', ...lines, ''] : []),
        `Open: ${notificationsUrl}`,
        '',
        `You can change email notification settings in Settings → Notifications.`,
      ].join('\n');

      const recentHtml = recentItems.length
        ? renderCard(
            [
              `<div style="font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">Recent</div>`,
              `<ul style="margin:10px 0 0 18px;padding:0;color:#111827;font-size:14px;line-height:1.6;">`,
              ...recentItems.map(
                (it) =>
                  `<li style="margin:0 0 8px 0;"><a href="${escapeHtml(it.href)}" style="color:#111827;text-decoration:none;">${escapeHtml(
                    it.text,
                  )}</a></li>`,
              ),
              `</ul>`,
            ].join(''),
          )
        : '';

      const html = renderMohEmail({
        title: `Unread notifications`,
        preheader: `You have ${undelivered} new notification${undelivered === 1 ? '' : 's'}.`,
        contentHtml: [
          `<div style="font-size:20px;font-weight:900;line-height:1.25;margin:0 0 6px 0;color:#111827;">You have ${undelivered} new notification${
            undelivered === 1 ? '' : 's'
          }</div>`,
          `<div style="margin:0 0 10px 0;font-size:14px;line-height:1.7;color:#374151;">${escapeHtml(greeting)}</div>`,
          `<div style="margin-top:10px;display:block;">${renderButton({ href: notificationsUrl, label: 'Open notifications' })}</div>`,
          recentHtml,
          `<div style="margin-top:14px;font-size:13px;line-height:1.7;color:#6b7280;">Manage email notification settings: <a href="${escapeHtml(
            `${baseUrl}/settings/notifications`,
          )}" style="color:#111827;text-decoration:underline;">Settings → Notifications</a></div>`,
        ].join(''),
        footerHtml: `Men of Hunger`,
      });

      const sent = await this.email.sendText({
        to,
        subject: `You have ${undelivered} new notification${undelivered === 1 ? '' : 's'}`,
        text,
        html,
        from: this.appConfig.email()?.fromEmail.notifications ?? undefined,
      });

      if (sent.sent) {
        await this.prisma.notificationPreferences.upsert({
          where: { userId: u.id },
          create: { userId: u.id, lastEmailNewNotificationsSentAt: now },
          update: { lastEmailNewNotificationsSentAt: now },
        });
      } else {
        this.logger.debug(`[email-nudges] not sent to userId=${u.id} reason=${sent.reason ?? 'unknown'}`);
      }
    }
  }

  /** Daily digest (send once per day; target 8am ET, DST-safe). */
  @Cron('*/5 * * * *')
  async sendDailyDigest(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    try {
      const now = new Date();
      const et = easternYmdHm(now);
      const minuteOfDay = et.hh * 60 + et.mm;
      // Only enqueue in the 8:00-8:59am ET window.
      if (minuteOfDay < 8 * 60 || minuteOfDay >= 9 * 60) return;
      const dayKey = easternDayKey(now);
      await this.jobs.enqueueCron(JOBS.notificationsDailyDigest, {}, `cron:notificationsDailyDigest:${dayKey}`, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  /** Streak reminder (send once per day; target ~4pm ET, DST-safe). */
  @Cron('*/5 * * * *')
  async sendStreakReminderEmail(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    try {
      const now = new Date();
      const et = easternYmdHm(now);
      const minuteOfDay = et.hh * 60 + et.mm;
      // Only enqueue in the 4:00-4:59pm ET window.
      if (minuteOfDay < 16 * 60 || minuteOfDay >= 17 * 60) return;
      const dayKey = easternDayKey(now);
      await this.jobs.enqueueCron(JOBS.notificationsStreakReminderEmail, {}, `cron:notificationsStreakReminderEmail:${dayKey}`, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  async runSendStreakReminderEmail(): Promise<void> {
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    const now = new Date();
    const et = easternYmdHm(now);
    const minuteOfDay = et.hh * 60 + et.mm;
    if (minuteOfDay < 16 * 60 || minuteOfDay >= 17 * 60) return;

    const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
    const homeUrl = `${baseUrl}/home`;
    const settingsUrl = `${baseUrl}/settings/notifications`;

    const todayEt = easternYmd(now);
    const windowStartUtcMs = easternUtcMsForLocal({ ...todayEt, hh: 16, mm: 0 });
    const sendStartUtc = new Date(windowStartUtcMs);

    const todayKey = easternDayKey(now);
    const yesterdayKey = easternDayKey(new Date(now.getTime() - 36 * 60 * 60 * 1000));

    type RecipientRow = {
      id: string;
      email: string | null;
      username: string | null;
      name: string | null;
      checkinStreakDays: number;
      lastCheckinDayKey: string | null;
      notificationPreferences: { emailStreakReminder: boolean; lastEmailStreakReminderSentAt: Date | null } | null;
    };

    let cursorId: string | null = null;
    const pageSize = 400;
    for (;;) {
      const recipients: RecipientRow[] = await this.prisma.user.findMany({
        where: {
          email: { not: null },
          emailVerifiedAt: { not: null },
          checkinStreakDays: { gt: 0 },
          lastCheckinDayKey: yesterdayKey, // at risk: last activity was yesterday (ET)
          ...(cursorId ? { id: { gt: cursorId } } : {}),
          OR: [
            { notificationPreferences: { is: null } },
            { notificationPreferences: { is: { emailStreakReminder: true } } },
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
          lastCheckinDayKey: true,
          notificationPreferences: { select: { emailStreakReminder: true, lastEmailStreakReminderSentAt: true } },
        },
      });
      if (recipients.length === 0) break;
      cursorId = recipients[recipients.length - 1]?.id ?? null;

      for (const u of recipients) {
        const to = (u.email ?? '').trim();
        if (!to) continue;
        if (u.notificationPreferences && !u.notificationPreferences.emailStreakReminder) continue;

        const lastSent = u.notificationPreferences?.lastEmailStreakReminderSentAt ?? null;
        if (lastSent && lastSent.getTime() >= sendStartUtc.getTime()) continue;

        // Defensive: if they already posted today, don't send.
        if ((u.lastCheckinDayKey ?? null) === todayKey) continue;

        const currentStreak = Math.max(0, Math.floor(u.checkinStreakDays ?? 0));
        if (currentStreak <= 0) continue;

        // What they'll earn today if they post/reply at least once.
        const reward = computeCheckinRewards({
          todayKey,
          yesterdayKey,
          lastCheckinDayKey: yesterdayKey,
          currentStreakDays: currentStreak,
        });

        const greetingName = (u.name ?? u.username ?? '').trim();
        const greeting = greetingName ? `Hey ${greetingName},` : `Hey,`;

        const subject = `Don’t lose your streak (${currentStreak} day${currentStreak === 1 ? '' : 's'})`;

        const text = [
          greeting,
          '',
          `You’re on a ${currentStreak}-day streak.`,
          `Post or reply today to keep it.`,
          '',
          `Today’s multiplier: ${reward.multiplier}x (${reward.coinsAdd} coin${reward.coinsAdd === 1 ? '' : 's'} for one post/reply)`,
          `If you skip today, your streak resets to 0.`,
          '',
          `Open: ${homeUrl}`,
          '',
          `Manage email notification settings: ${settingsUrl}`,
        ].join('\n');

        const html = renderMohEmail({
          title: `Keep your streak`,
          preheader: `Post or reply today to keep your ${currentStreak}-day streak.`,
          contentHtml: [
            `<div style="font-size:20px;font-weight:900;line-height:1.25;margin:0 0 6px 0;color:#111827;">Keep your streak</div>`,
            `<div style="margin:0 0 10px 0;font-size:14px;line-height:1.7;color:#374151;">${escapeHtml(greeting)}</div>`,
            renderCard(
              [
                `<div style="margin-bottom:10px;">${renderPill('Streak reminder', 'warning')}</div>`,
                `<div style="font-size:14px;line-height:1.8;color:#111827;">You’re on a <strong>${currentStreak}</strong>-day streak.</div>`,
                `<div style="margin-top:10px;font-size:14px;line-height:1.8;color:#111827;">Post or reply <strong>today</strong> to keep it.</div>`,
                `<div style="margin-top:10px;font-size:13px;line-height:1.7;color:#6b7280;">Today’s multiplier: <strong style="color:#111827;">${reward.multiplier}x</strong> (${reward.coinsAdd} coin${reward.coinsAdd === 1 ? '' : 's'}).</div>`,
                `<div style="margin-top:10px;font-size:13px;line-height:1.7;color:#6b7280;">If you skip today, your streak resets to 0.</div>`,
                `<div style="margin-top:12px;">${renderButton({ href: homeUrl, label: 'Post now' })}</div>`,
              ].join(''),
            ),
            `<div style="margin-top:16px;font-size:13px;line-height:1.8;color:#6b7280;">Manage notification settings: <a href="${escapeHtml(
              settingsUrl,
            )}" style="color:#111827;text-decoration:underline;">${escapeHtml(settingsUrl)}</a></div>`,
          ].join(''),
          footerHtml: `Manage notifications in <a href="${escapeHtml(
            settingsUrl,
          )}" style="color:#9ca3af;text-decoration:underline;">Settings → Notifications</a> · Men of Hunger`,
        });

        const sent = await this.email.sendText({
          to,
          subject,
          text,
          html,
          from: this.appConfig.email()?.fromEmail.notifications ?? undefined,
        });

        if (sent.sent) {
          await this.prisma.notificationPreferences.upsert({
            where: { userId: u.id },
            create: { userId: u.id, lastEmailStreakReminderSentAt: now },
            update: { lastEmailStreakReminderSentAt: now },
          });
        } else {
          this.logger.debug(`[streak-reminder] not sent to userId=${u.id} reason=${sent.reason ?? 'unknown'}`);
        }
      }
    }
  }

  async runSendDailyDigest(): Promise<void> {
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    const now = new Date();
    const et = easternYmdHm(now);
    const minuteOfDay = et.hh * 60 + et.mm;
    if (minuteOfDay < 8 * 60 || minuteOfDay >= 9 * 60) return;

    const todayEt = easternYmd(now);
    const yesterdayEt = easternYmd(new Date(now.getTime() - 36 * 60 * 60 * 1000));
    const windowEndUtcMs = easternUtcMsForLocal({ ...todayEt, hh: 8, mm: 0 });
    const windowStartUtcMs = easternUtcMsForLocal({ ...yesterdayEt, hh: 8, mm: 0 });
    const sendStartUtc = new Date(windowEndUtcMs);

    const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
    const notificationsUrl = `${baseUrl}/notifications`;
    const messagesUrl = `${baseUrl}/chat`;
    const settingsUrl = `${baseUrl}/settings/notifications`;
    const checkinsUrl = `${baseUrl}/home`;

    // Ensure daily content exists (quote + definition).
    await this.dailyContent.refreshForTodayIfNeeded(now);
    const dayKey = easternDayKey(now);
    const snap = await this.prisma.dailyContentSnapshot.findUnique({
      where: { dayKey },
      select: { quote: true, websters1828: true },
    });

    const quote = (snap?.quote ?? null) as any;
    const wotd = (snap?.websters1828 ?? null) as any;
    const checkinPrompt = pickDailyCheckinPrompt(now).prompt;

    // Featured post: highest trending score among posts created in window.
    // NOTE: Digest recipients may not have access to all visibilities (verified/premium). Precompute by tier and pick per-user.
    const latestAsOf = await this.prisma.postPopularScoreSnapshot.findFirst({
      orderBy: [{ asOf: 'desc' }],
      select: { asOf: true },
    });
    const featuredRowPublic =
      latestAsOf?.asOf
        ? await this.prisma.postPopularScoreSnapshot.findFirst({
            where: {
              asOf: latestAsOf.asOf,
              createdAt: { gte: new Date(windowStartUtcMs), lt: new Date(windowEndUtcMs) },
              parentId: null,
              visibility: { in: ['public'] },
            },
            orderBy: [{ score: 'desc' }, { createdAt: 'desc' }, { postId: 'desc' }],
            select: { postId: true },
          })
        : null;
    const featuredRowVerified =
      latestAsOf?.asOf
        ? await this.prisma.postPopularScoreSnapshot.findFirst({
            where: {
              asOf: latestAsOf.asOf,
              createdAt: { gte: new Date(windowStartUtcMs), lt: new Date(windowEndUtcMs) },
              parentId: null,
              visibility: { in: ['public', 'verifiedOnly'] },
            },
            orderBy: [{ score: 'desc' }, { createdAt: 'desc' }, { postId: 'desc' }],
            select: { postId: true },
          })
        : null;
    const featuredRowPremium =
      latestAsOf?.asOf
        ? await this.prisma.postPopularScoreSnapshot.findFirst({
            where: {
              asOf: latestAsOf.asOf,
              createdAt: { gte: new Date(windowStartUtcMs), lt: new Date(windowEndUtcMs) },
              parentId: null,
              visibility: { in: ['public', 'verifiedOnly', 'premiumOnly'] },
            },
            orderBy: [{ score: 'desc' }, { createdAt: 'desc' }, { postId: 'desc' }],
            select: { postId: true },
          })
        : null;

    const featuredPostPublic = featuredRowPublic?.postId
      ? await this.prisma.post.findFirst({
          where: { id: featuredRowPublic.postId, deletedAt: null },
          select: { id: true, body: true, createdAt: true, user: { select: { username: true, name: true } } },
        })
      : null;
    const featuredPostVerified = featuredRowVerified?.postId
      ? await this.prisma.post.findFirst({
          where: { id: featuredRowVerified.postId, deletedAt: null },
          select: { id: true, body: true, createdAt: true, user: { select: { username: true, name: true } } },
        })
      : null;
    const featuredPostPremium = featuredRowPremium?.postId
      ? await this.prisma.post.findFirst({
          where: { id: featuredRowPremium.postId, deletedAt: null },
          select: { id: true, body: true, createdAt: true, user: { select: { username: true, name: true } } },
        })
      : null;

    function pickFeaturedPostForUser(u: { verifiedStatus?: string | null; premium?: boolean | null; premiumPlus?: boolean | null }) {
      const isPremium = Boolean(u.premium || u.premiumPlus);
      const isVerified = (u.verifiedStatus ?? 'none') !== 'none';
      if (isPremium) return featuredPostPremium ?? featuredPostVerified ?? featuredPostPublic;
      if (isVerified) return featuredPostVerified ?? featuredPostPublic;
      return featuredPostPublic;
    }

    type DigestRecipientRow = {
      id: string;
      email: string | null;
      username: string | null;
      name: string | null;
      verifiedStatus: 'none' | 'identity' | 'manual';
      premium: boolean;
      premiumPlus: boolean;
      undeliveredNotificationCount: number;
      checkinStreakDays: number;
      notificationPreferences: { emailDigestDaily: boolean; lastEmailDigestDailySentAt: Date | null } | null;
    };

    let cursorId: string | null = null;
    const pageSize = 200;
    for (;;) {
      const recipients: DigestRecipientRow[] = await this.prisma.user.findMany({
        where: {
          email: { not: null },
          emailVerifiedAt: { not: null },
          ...(cursorId ? { id: { gt: cursorId } } : {}),
          OR: [
            { notificationPreferences: { is: null } },
            { notificationPreferences: { is: { emailDigestDaily: true } } },
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
          undeliveredNotificationCount: true,
          checkinStreakDays: true,
          notificationPreferences: { select: { emailDigestDaily: true, lastEmailDigestDailySentAt: true } },
        },
      });
      if (recipients.length === 0) break;
      cursorId = recipients[recipients.length - 1]?.id ?? null;

      for (const u of recipients) {
        const to = (u.email ?? '').trim();
        if (!to) continue;
        if (u.notificationPreferences && !u.notificationPreferences.emailDigestDaily) continue;

        const lastSent = u.notificationPreferences?.lastEmailDigestDailySentAt ?? null;
        if (lastSent && lastSent.getTime() >= sendStartUtc.getTime()) continue;

        const unreadNotifs = u.undeliveredNotificationCount ?? 0;
        const unreadChats = await this.messages
          .getUnreadSummary(u.id)
          .then((c) => (c.primary ?? 0) + (c.requests ?? 0))
          .catch(() => 0);

        const greetingName = (u.name ?? u.username ?? '').trim();
        const greeting = greetingName ? `Good morning ${greetingName},` : `Good morning,`;

        let subject = 'Your daily Men of Hunger digest';
        if (unreadNotifs > 0 && unreadChats > 0) {
          subject = `You have ${unreadNotifs} unread notification${unreadNotifs === 1 ? '' : 's'} and ${unreadChats} unread message${
            unreadChats === 1 ? '' : 's'
          } — Daily digest`;
        } else if (unreadNotifs > 0) {
          subject = `You have ${unreadNotifs} unread notification${unreadNotifs === 1 ? '' : 's'} — Daily digest`;
        } else if (unreadChats > 0) {
          subject = `You have ${unreadChats} unread message${unreadChats === 1 ? '' : 's'} — Daily digest`;
        }

        const quoteText = quote?.text ? String(quote.text).trim() : '';
        const quoteAttr =
          quote?.kind === 'scripture'
            ? [quote?.reference, quote?.tradition].filter(Boolean).join(' · ')
            : (quote?.author ?? '').toString().trim();

        const word = wotd?.word ? String(wotd.word).trim() : '';
        const definition = wotd?.definition ? String(wotd.definition).trim() : '';
        const dictionaryUrl = wotd?.dictionaryUrl ? String(wotd.dictionaryUrl).trim() : '';

        const featuredPost = pickFeaturedPostForUser(u);
        const featuredUrl = featuredPost ? `${baseUrl}/p/${encodeURIComponent(featuredPost.id)}` : null;

        const featuredTextLines = featuredPost
          ? [
              'Featured post (last 24 hours, since 8am ET yesterday)',
              `by @${(featuredPost.user.username ?? 'unknown').trim()}\n${truncate(featuredPost.body ?? '', 240)}\nOpen: ${featuredUrl ?? ''}`.trim(),
              '',
            ]
          : [];

        const text = [
          greeting,
          '',
          unreadNotifs > 0
            ? `You have ${unreadNotifs} unread notification${unreadNotifs === 1 ? '' : 's'} — ${notificationsUrl}`
            : `Notifications: ${notificationsUrl}`,
          unreadChats > 0 ? `You have ${unreadChats} unread message${unreadChats === 1 ? '' : 's'} — ${messagesUrl}` : `Messages: ${messagesUrl}`,
          '',
          ...featuredTextLines,
          'Definition of the day',
          word ? word : '(unavailable)',
          definition ? definition : '',
          dictionaryUrl ? `Source: ${dictionaryUrl}` : '',
          '',
          'Quote of the day',
          quoteText ? `“${quoteText}”` : '(unavailable)',
          quoteAttr ? `— ${quoteAttr}` : '',
          '',
          'Daily check-in',
          checkinPrompt ? `“${checkinPrompt}”` : '(unavailable)',
          `Your streak: ${Math.max(0, Math.floor(u.checkinStreakDays ?? 0))} day${Math.max(0, Math.floor(u.checkinStreakDays ?? 0)) === 1 ? '' : 's'}`,
          `Check in: ${checkinsUrl}`,
          '',
          `Manage notification settings: ${settingsUrl}`,
        ]
          .filter((l) => l !== '')
          .join('\n');

        const quoteBlock = quoteText
          ? renderCard(
              [
                `<div style="margin-bottom:10px;">${renderPill('Quote of the day', 'info')}</div>`,
                `<div style="font-size:16px;line-height:1.7;color:#111827;">“${escapeHtml(quoteText)}”</div>`,
                quoteAttr ? `<div style="margin-top:10px;font-size:13px;line-height:1.7;color:#6b7280;">— ${escapeHtml(quoteAttr)}</div>` : ``,
              ].join(''),
            )
          : renderCard(`<div>${renderPill('Quote of the day', 'info')}</div><div style="margin-top:10px;color:#6b7280;">(unavailable)</div>`);

        const streakDays = Math.max(0, Math.floor(u.checkinStreakDays ?? 0));
        const checkinBlock = renderCard(
          [
            `<div style="margin-bottom:10px;">${renderPill('Daily check-in', 'warning')}</div>`,
            `<div style="font-size:14px;line-height:1.8;color:#111827;">${escapeHtml(checkinPrompt || '(unavailable)')}</div>`,
            `<div style="margin-top:10px;font-size:13px;line-height:1.7;color:#6b7280;">Your streak: <strong style="color:#111827;">${streakDays}</strong> day${streakDays === 1 ? '' : 's'}</div>`,
            `<div style="margin-top:12px;">${renderButton({ href: checkinsUrl, label: 'Check in' })}</div>`,
          ].join(''),
        );

        const definitionBlock = word && definition
          ? renderCard(
              [
                `<div style="margin-bottom:10px;">${renderPill('Definition of the day', 'neutral')}</div>`,
                `<div style="font-size:14px;line-height:1.8;color:#111827;"><strong style="letter-spacing:0.06em;">${escapeHtml(
                  word.toUpperCase(),
                )}</strong> — ${escapeHtml(definition).replace(/\n/g, '<br/>')}</div>`,
                dictionaryUrl
                  ? `<div style="margin-top:10px;font-size:13px;line-height:1.7;color:#6b7280;">Source: <a href="${escapeHtml(
                      dictionaryUrl,
                    )}" style="color:#111827;text-decoration:underline;">Webster’s 1828</a></div>`
                  : ``,
              ].join(''),
            )
          : renderCard(`<div>${renderPill('Definition of the day', 'neutral')}</div><div style="margin-top:10px;color:#6b7280;">(unavailable)</div>`);

        const featuredHtml = featuredPost
          ? renderCard(
              [
                `<div style="margin-bottom:10px;">${renderPill('Featured post', 'success')}</div>`,
                `<div style="font-size:13px;line-height:1.7;color:#6b7280;">by <strong style="color:#111827;">@${escapeHtml(
                  (featuredPost.user.username ?? 'unknown').trim(),
                )}</strong></div>`,
                `<div style="margin-top:10px;font-size:14px;line-height:1.8;color:#111827;">${escapeHtml(
                  truncate(featuredPost.body ?? '', 260),
                )}</div>`,
                featuredUrl ? `<div style="margin-top:12px;">${renderButton({ href: featuredUrl, label: 'Open post' })}</div>` : ``,
              ].join(''),
            )
          : '';

        const unreadLine =
          unreadNotifs > 0 && unreadChats > 0
            ? `You have ${unreadNotifs} unread notification${unreadNotifs === 1 ? '' : 's'} and ${unreadChats} unread message${
                unreadChats === 1 ? '' : 's'
              }.`
            : unreadNotifs > 0
              ? `You have ${unreadNotifs} unread notification${unreadNotifs === 1 ? '' : 's'}.`
              : unreadChats > 0
                ? `You have ${unreadChats} unread message${unreadChats === 1 ? '' : 's'}.`
                : `Here’s today’s digest.`;

        const html = renderMohEmail({
          title: `Daily digest`,
          preheader: unreadLine,
          contentHtml: [
            `<div style="font-size:20px;font-weight:900;line-height:1.25;margin:0 0 6px 0;color:#111827;">Daily digest</div>`,
            `<div style="margin:0 0 10px 0;font-size:14px;line-height:1.7;color:#374151;">${escapeHtml(greeting)}</div>`,
            `<div style="margin:0 0 14px 0;">${renderPill(unreadLine, unreadNotifs > 0 || unreadChats > 0 ? 'warning' : 'neutral')}</div>`,
            `<div style="margin-top:6px;">${renderButton({ href: notificationsUrl, label: 'Notifications' })} <span style="display:inline-block;width:8px;"></span> ${renderButton({
              href: messagesUrl,
              label: 'Messages',
              variant: 'secondary',
            })}</div>`,
            `<div style="height:12px;"></div>`,
            ...(featuredPost ? [featuredHtml] : []),
            definitionBlock,
            quoteBlock,
            checkinBlock,
            `<div style="margin-top:16px;font-size:13px;line-height:1.8;color:#6b7280;">Manage notification settings: <a href="${escapeHtml(
              settingsUrl,
            )}" style="color:#111827;text-decoration:underline;">${escapeHtml(settingsUrl)}</a></div>`,
          ].join(''),
          footerHtml: `Manage notifications in <a href="${escapeHtml(
            settingsUrl,
          )}" style="color:#9ca3af;text-decoration:underline;">Settings → Notifications</a> · Men of Hunger`,
        });

        const sent = await this.email.sendText({
          to,
          subject,
          text,
          html,
          from: this.appConfig.email()?.fromEmail.notifications ?? undefined,
        });
        if (sent.sent) {
          await this.prisma.notificationPreferences.upsert({
            where: { userId: u.id },
            create: { userId: u.id, lastEmailDigestDailySentAt: now },
            update: { lastEmailDigestDailySentAt: now },
          });
        } else {
          this.logger.debug(`[daily-digest] not sent to userId=${u.id} reason=${sent.reason ?? 'unknown'}`);
        }
      }
    }
  }

  /**
   * Near-immediate high-signal email (optional, user-controlled):
   * - New direct message activity
   * - Mentions + replies (notification kinds: mention, comment)
   *
   * This job is intended to be enqueued with a short delay so multiple events can batch.
   */
  async runSendInstantHighSignalEmail(payload: unknown): Promise<void> {
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    const userId = typeof (payload as any)?.userId === 'string' ? String((payload as any).userId).trim() : '';
    if (!userId) return;

    const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
    const notificationsUrl = `${baseUrl}/notifications`;
    const chatBaseUrl = `${baseUrl}/chat`;
    const settingsUrl = `${baseUrl}/settings/notifications`;

    const now = new Date();
    const prefs = await this.prisma.notificationPreferences.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: {
        emailInstantHighSignal: true,
        lastEmailInstantHighSignalSentAt: true,
        user: { select: { email: true, emailVerifiedAt: true, username: true, name: true } },
      },
    });

    const to = (prefs.user.email ?? '').trim();
    if (!to) return;
    if (!prefs.user.emailVerifiedAt) return;
    if (!prefs.emailInstantHighSignal) return;

    const lastSent = prefs.lastEmailInstantHighSignalSentAt;
    if (lastSent && now.getTime() - lastSent.getTime() < this.INSTANT_EMAIL_COOLDOWN_MS) return;

    const since = lastSent ? lastSent : new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [notifs, unreadChats, unreadConversations] = await Promise.all([
      this.prisma.notification.findMany({
        where: {
          recipientUserId: userId,
          kind: { in: ['mention', 'comment'] },
          // Smart-cancel: if the user has opened the app and the notification was delivered,
          // we should not send the bundled email for it.
          deliveredAt: null,
          readAt: null,
          createdAt: { gt: since },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 8,
        select: {
          id: true,
          kind: true,
          title: true,
          body: true,
          createdAt: true,
          subjectPostId: true,
          actor: { select: { username: true, name: true, premium: true, premiumPlus: true, isOrganization: true, verifiedStatus: true } },
          subjectPost: { select: { visibility: true } },
        },
      }),
      this.messages
        .getUnreadSummary(userId)
        .then((c) => (c.primary ?? 0) + (c.requests ?? 0))
        .catch(() => 0),
      this.prisma.messageParticipant.findMany({
        where: { userId, status: 'accepted' },
        select: {
          updatedAt: true,
          lastReadAt: true,
          conversation: {
            select: {
              id: true,
              lastMessageAt: true,
              lastMessage: { select: { senderId: true, body: true, createdAt: true, sender: { select: { username: true, name: true } } } },
            },
          },
        },
        orderBy: [{ updatedAt: 'desc' }],
        take: 6,
      }),
    ]);

    const hasHighSignalNotifs = Array.isArray(notifs) && notifs.length > 0;
    const hasUnreadChats = unreadChats > 0;
    if (!hasHighSignalNotifs && !hasUnreadChats) return;

    const mentionCount = hasHighSignalNotifs ? notifs.filter((n) => n.kind === 'mention').length : 0;
    const replyCount = hasHighSignalNotifs ? notifs.filter((n) => n.kind === 'comment').length : 0;
    const notifsNoun =
      mentionCount > 0 && replyCount > 0 ? 'mentions and replies' : mentionCount > 0 ? 'mentions' : replyCount > 0 ? 'replies' : 'activity';

    const greetingName = (prefs.user.name ?? prefs.user.username ?? '').trim();
    const greeting = greetingName ? `Hey ${greetingName},` : `Hey,`;

    const subject =
      hasUnreadChats && hasHighSignalNotifs
        ? `New messages and ${notifsNoun} on Men of Hunger`
        : hasUnreadChats
          ? `You have new messages on Men of Hunger`
          : `You have new ${notifsNoun} on Men of Hunger`;

    const chatPreviewRows = hasUnreadChats
      ? ((unreadConversations ?? [])
          .map((p) => {
            const lastReadAt = p.lastReadAt ?? null;
            const conv = p.conversation ?? null;
            const lastMsg = conv?.lastMessage ?? null;
            if (!conv?.id || !conv.lastMessageAt || !lastMsg) return null;
            // Only show previews for unread messages from someone else.
            if (lastReadAt && conv.lastMessageAt.getTime() <= lastReadAt.getTime()) return null;
            if (lastMsg.senderId === userId) return null;
            const sender = (lastMsg.sender?.name ?? lastMsg.sender?.username ?? 'Someone').trim();
            const body = truncate((lastMsg.body ?? '').trim(), 140);
            const href = `${chatBaseUrl}?c=${encodeURIComponent(conv.id)}`;
            return { sender, body, href };
          })
          .filter(Boolean)
          .slice(0, 3) as Array<{ sender: string; body: string; href: string }>)
      : [];

    // Best link target for "Open chat" buttons: the newest unread conversation if we can infer it.
    const chatUrl = chatPreviewRows[0]?.href ?? chatBaseUrl;

    const notifLines = notifs.map((n) => {
      const actor = (n.actor?.username ?? n.actor?.name ?? 'Someone').trim();
      const label = n.kind === 'comment' ? 'Reply' : 'Mention';
      const msg = truncate((n.body ?? n.title ?? '').trim(), 140);
      return `- ${label} from @${actor}: ${msg}`.trim();
    });

    type ActorTier = 'premium' | 'verified' | 'organization' | null;
    function actorTierFor(n: typeof notifs[number]): ActorTier {
      const a = n.actor as null | {
        premium?: boolean | null;
        premiumPlus?: boolean | null;
        isOrganization?: boolean | null;
        verifiedStatus?: string | null;
      };
      if (!a) return null;
      if (a.isOrganization) return 'organization';
      if (Boolean(a.premium || a.premiumPlus)) return 'premium';
      if ((a.verifiedStatus ?? 'none') !== 'none') return 'verified';
      return null;
    }
    function actorTierLabel(tier: ActorTier): string {
      if (tier === 'organization') return 'Organization';
      if (tier === 'premium') return 'Premium';
      if (tier === 'verified') return 'Verified';
      return '';
    }
    type PostVisibility = 'public' | 'verifiedOnly' | 'premiumOnly' | 'onlyMe';
    function postVisibilityFor(n: typeof notifs[number]): PostVisibility | null {
      const vis = (n as any)?.subjectPost?.visibility;
      if (vis === 'public' || vis === 'verifiedOnly' || vis === 'premiumOnly' || vis === 'onlyMe') return vis;
      return null;
    }
    function postVisibilityLabel(vis: PostVisibility | null): string {
      if (vis === 'verifiedOnly') return 'Verified post';
      if (vis === 'premiumOnly') return 'Premium post';
      if (vis === 'onlyMe') return 'Only me';
      return '';
    }

    const text = [
      greeting,
      '',
      hasUnreadChats ? `You have ${unreadChats} unread message${unreadChats === 1 ? '' : 's'} — ${chatUrl}` : '',
      hasHighSignalNotifs ? `Recent ${notifsNoun} — ${notificationsUrl}` : '',
      ...(hasHighSignalNotifs ? [''].concat(notifLines).concat(['']) : []),
      `Open chat: ${chatUrl}`,
      `Open notifications: ${notificationsUrl}`,
      '',
      `Manage notification settings: ${settingsUrl}`,
    ]
      .filter(Boolean)
      .join('\n');

    const convoCards = (() => {
      if (!hasUnreadChats) return '';
      return renderCard(
        [
          `<div style="margin-bottom:10px;">${renderPill('Messages', 'warning')}</div>`,
          `<div style="font-size:14px;line-height:1.8;color:#111827;">You have <strong>${unreadChats}</strong> unread message${
            unreadChats === 1 ? '' : 's'
          }.</div>`,
          chatPreviewRows.length
            ? `<div style="margin-top:10px;font-size:13px;line-height:1.7;color:#6b7280;">Latest:</div>
<ul style="margin:8px 0 0 18px;padding:0;color:#111827;font-size:14px;line-height:1.6;">
${chatPreviewRows
  .map(
    (r) =>
      `<li style="margin:0 0 8px 0;"><a href="${escapeHtml(r.href)}" style="color:#111827;text-decoration:none;"><strong>${escapeHtml(
        r.sender,
      )}</strong> — ${escapeHtml(r.body)}</a></li>`,
  )
  .join('')}
</ul>`
            : ``,
          `<div style="margin-top:12px;">${renderButton({ href: chatUrl, label: 'Open chat' })}</div>`,
        ].join(''),
      );
    })();

    const notifCard = hasHighSignalNotifs
      ? renderCard(
          [
            `<div style="margin-bottom:10px;">${renderPill('Mentions & replies', 'info')}</div>`,
            `<ul style="margin:0 0 0 18px;padding:0;color:#111827;font-size:14px;line-height:1.6;">`,
            ...notifs.slice(0, 5).map((n) => {
              const actor = (n.actor?.username ?? n.actor?.name ?? 'Someone').trim();
              const label = n.kind === 'comment' ? 'Reply' : 'Mention';
              const msg = truncate((n.body ?? n.title ?? '').trim(), 140);
              const href = n.subjectPostId ? `${baseUrl}/p/${encodeURIComponent(n.subjectPostId)}` : notificationsUrl;
              const tier = actorTierFor(n as any);
              const tierPill = tier ? ` <span style="display:inline-block;width:6px;"></span>${renderPill(actorTierLabel(tier), { actorTier: tier })}` : '';
              const vis = postVisibilityFor(n as any);
              const visPill =
                vis && vis !== 'public'
                  ? ` <span style="display:inline-block;width:6px;"></span>${renderPill(postVisibilityLabel(vis), { postVisibility: vis })}`
                  : '';
              return `<li style="margin:0 0 10px 0;"><a href="${escapeHtml(
                href,
              )}" style="color:#111827;text-decoration:none;"><strong>${escapeHtml(label)}</strong> from <strong>@${escapeHtml(
                actor,
              )}</strong>${tierPill}${visPill} — ${escapeHtml(msg)}</a></li>`;
            }),
            `</ul>`,
            `<div style="margin-top:12px;">${renderButton({ href: notificationsUrl, label: 'Open notifications', variant: 'secondary' })}</div>`,
          ].join(''),
        )
      : '';

    const previewText =
      hasUnreadChats && hasHighSignalNotifs
        ? `New messages and ${notifsNoun} waiting for you.`
        : hasUnreadChats
          ? `You have new messages waiting for you.`
          : `You have new ${notifsNoun}.`;

    const html = renderMohEmail({
      title: 'New activity',
      preheader: previewText,
      contentHtml: [
        `<div style="font-size:20px;font-weight:900;line-height:1.25;margin:0 0 6px 0;color:#111827;">New activity</div>`,
        `<div style="margin:0 0 10px 0;font-size:14px;line-height:1.7;color:#374151;">${escapeHtml(greeting)}</div>`,
        `<div style="margin:0 0 14px 0;">${renderPill(previewText, 'neutral')}</div>`,
        convoCards,
        notifCard,
        `<div style="margin-top:14px;font-size:13px;line-height:1.8;color:#6b7280;">You can turn off instant emails in <a href="${escapeHtml(
          settingsUrl,
        )}" style="color:#111827;text-decoration:underline;">Settings → Notifications</a>.</div>`,
      ]
        .filter(Boolean)
        .join(''),
      footerHtml: `Men of Hunger`,
    });

    const sent = await this.email.sendText({
      to,
      subject,
      text,
      html,
      from: this.appConfig.email()?.fromEmail.notifications ?? undefined,
    });

    if (sent.sent) {
      await this.prisma.notificationPreferences.upsert({
        where: { userId },
        create: { userId, lastEmailInstantHighSignalSentAt: now },
        update: { lastEmailInstantHighSignalSentAt: now },
      });
    }
  }

  async enqueueInstantHighSignalEmail(userId: string): Promise<void> {
    const id = String(userId ?? '').trim();
    if (!id) return;
    try {
      await this.jobs.enqueueCron(
        JOBS.notificationsInstantHighSignalEmail,
        { userId: id },
        `notifications:instantHighSignalEmail:${id}`,
        {
          delay: this.INSTANT_EMAIL_DELAY_MS,
          attempts: 2,
          backoff: { type: 'exponential', delay: 60_000 },
        },
      );
    } catch {
      // likely duplicate jobId; treat as no-op (batching).
    }
  }
}

