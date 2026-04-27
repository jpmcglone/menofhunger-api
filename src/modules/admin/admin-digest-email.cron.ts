import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { VerifiedStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AppConfigService } from '../app/app-config.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { escapeHtml, renderButton, renderCard, renderMohEmail, renderPill } from '../email/templates/moh-email';
import { SlackService } from '../../common/slack/slack.service';

// ─── ET helpers ───────────────────────────────────────────────────────────────

const ET_ZONE = 'America/New_York';

function safeBaseUrl(raw: string | null | undefined): string {
  return ((raw ?? '').trim() || 'https://menofhunger.com').replace(/\/$/, '');
}

function easternYmd(d: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  return {
    y: Number(parts.find((p) => p.type === 'year')?.value ?? 0),
    m: Number(parts.find((p) => p.type === 'month')?.value ?? 1),
    d: Number(parts.find((p) => p.type === 'day')?.value ?? 1),
  };
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
  const hhRaw = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  return {
    y: Number(parts.find((p) => p.type === 'year')?.value ?? 0),
    m: Number(parts.find((p) => p.type === 'month')?.value ?? 1),
    d: Number(parts.find((p) => p.type === 'day')?.value ?? 1),
    hh: Number.isFinite(hhRaw) ? ((hhRaw % 24) + 24) % 24 : 0,
    mm: Number(parts.find((p) => p.type === 'minute')?.value ?? 0),
  };
}

function easternDayKey(d: Date): string {
  const { y, m, d: dd } = easternYmd(d);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function easternUtcMsForLocal(params: { y: number; m: number; d: number; hh: number; mm: number }): number {
  for (let utcHour = 0; utcHour <= 23; utcHour++) {
    const cand = new Date(Date.UTC(params.y, params.m - 1, params.d, utcHour, params.mm, 0));
    const p = easternYmdHm(cand);
    if (p.y === params.y && p.m === params.m && p.d === params.d && p.hh === params.hh && p.mm === params.mm) {
      return cand.getTime();
    }
  }
  return Date.now();
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

function relativeTime(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function truncate(s: string, max: number): string {
  const t = (s ?? '').trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

type UserRow = {
  id: string;
  username: string | null;
  name: string | null;
  email: string | null;
  premium: boolean;
  premiumPlus: boolean;
  verifiedStatus: VerifiedStatus;
  isOrganization: boolean;
  createdAt: Date;
};

function renderTierBadge(user: Pick<UserRow, 'premium' | 'premiumPlus' | 'isOrganization' | 'verifiedStatus'>): string {
  if (user.premiumPlus) return renderPill('Premium+', 'warning');
  if (user.premium) return renderPill('Premium', 'warning');
  if (user.isOrganization) return renderPill('Org', 'neutral');
  if (user.verifiedStatus !== 'none') return renderPill('Verified', 'info');
  return '';
}

function renderNewUserRow(user: UserRow, now: Date, baseUrl: string): string {
  const displayName = user.name || user.username || '(no name)';
  const profileUrl = user.username ? `${baseUrl}/u/${encodeURIComponent(user.username)}` : '';
  const timeAgo = relativeTime(user.createdAt, now);
  const badge = renderTierBadge(user);

  const nameHtml = profileUrl
    ? `<a href="${escapeHtml(profileUrl)}" style="color:#111827;text-decoration:none;font-weight:600;font-size:13px;">${escapeHtml(displayName)}</a>`
    : `<span style="font-weight:600;font-size:13px;">${escapeHtml(displayName)}</span>`;

  const handleHtml = user.username
    ? `<span style="font-size:12px;color:#6b7280;margin-left:4px;">@${escapeHtml(user.username)}</span>`
    : '';

  return `
<div style="padding:7px 0;border-bottom:1px solid #f3f4f6;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
    <td style="vertical-align:middle;">${nameHtml}${handleHtml}${badge ? `<span style="margin-left:6px;">${badge}</span>` : ''}</td>
    <td style="vertical-align:middle;text-align:right;white-space:nowrap;font-size:11px;color:#9ca3af;">${escapeHtml(timeAgo)}</td>
  </tr></table>
</div>`.trim();
}

function renderStatRow(
  label: string,
  value: string | number,
  opts?: { href?: string; color?: string; dimZero?: boolean },
): string {
  const isZero = Number(value) === 0;
  const effectiveColor = opts?.color ?? (opts?.dimZero && isZero ? '#9ca3af' : '#111827');

  const valueHtml = opts?.href
    ? `<a href="${escapeHtml(opts.href)}" style="font-size:14px;font-weight:700;color:${effectiveColor};text-decoration:none;">${escapeHtml(String(value))} →</a>`
    : `<span style="font-size:14px;font-weight:700;color:${effectiveColor};">${escapeHtml(String(value))}</span>`;

  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-bottom:1px solid #f9fafb;"><tr>
  <td style="padding:5px 0;font-size:13px;color:#374151;">${escapeHtml(label)}</td>
  <td style="padding:5px 0;text-align:right;">${valueHtml}</td>
</tr></table>`.trim();
}

function sectionTitle(title: string, badge?: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:10px;"><tr>
  <td style="font-size:13px;font-weight:700;color:#111827;">${escapeHtml(title)}</td>
  ${badge ? `<td style="text-align:right;">${badge}</td>` : ''}
</tr></table>`;
}

// ─── Cron ─────────────────────────────────────────────────────────────────────

@Injectable()
export class AdminDailyDigestCron {
  private readonly logger = new Logger(AdminDailyDigestCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly appConfig: AppConfigService,
    private readonly jobs: JobsService,
    private readonly slack: SlackService,
  ) {}

  /** Every 5 min: enqueue in the 8:00–8:59am ET window (same hour as user digest). */
  @Cron('*/5 * * * *')
  async sendAdminDailyDigest(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    if (!this.appConfig.email()) return;

    const now = new Date();
    const et = easternYmdHm(now);
    const minuteOfDay = et.hh * 60 + et.mm;
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

      // Yesterday's ET midnight → today's ET midnight.
      const todayEt = easternYmd(now);
      const yesterdayUtc = new Date(Date.UTC(todayEt.y, todayEt.m - 1, todayEt.d - 1));
      const yesterdayEt = easternYmd(yesterdayUtc);
      const windowStart = new Date(easternUtcMsForLocal({ ...yesterdayEt, hh: 0, mm: 0 }));
      const windowEnd = new Date(easternUtcMsForLocal({ ...todayEt, hh: 0, mm: 0 }));

      // Gather all metrics in parallel.
      const [
        // New members
        newUsers,
        totalNewUserCount,
        // Content activity
        newFeedbackCount,
        newReportCount,
        newPostCount,
        newArticleCount,
        activeUserCount,
        bannedUserCount,
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
            id: true,
            username: true,
            name: true,
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
        this.prisma.feedback.count({ where: { createdAt: { gte: windowStart, lt: windowEnd } } }),
        this.prisma.report.count({ where: { createdAt: { gte: windowStart, lt: windowEnd } } }),
        this.prisma.post.count({
          where: { createdAt: { gte: windowStart, lt: windowEnd }, deletedAt: null, isDraft: false },
        }),
        this.prisma.article.count({
          where: { publishedAt: { gte: windowStart, lt: windowEnd }, deletedAt: null, isDraft: false },
        }),
        this.prisma.user.count({ where: { lastSeenAt: { gte: windowStart, lt: windowEnd } } }),
        this.prisma.user.count({ where: { bannedAt: { gte: windowStart, lt: windowEnd } } }),
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
            id: true,
            username: true,
            name: true,
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

      // Top post of yesterday: highest trendingScore among top-level posts created in window (admins see all).
      type TopPostRow = {
        id: string;
        body: string;
        boostCount: number;
        commentCount: number;
        viewerCount: number;
        username: string | null;
        name: string | null;
        visibility: string;
      };
      let topPost: TopPostRow | null = null;
      {
        const rawPost = await (this.prisma.post as any).findFirst({
          where: { deletedAt: null, parentId: null, createdAt: { gte: windowStart, lt: windowEnd }, trendingScore: { gt: 0 } },
          orderBy: [{ trendingScore: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, body: true, boostCount: true, commentCount: true, viewerCount: true, visibility: true, user: { select: { username: true, name: true } } },
        }) as { id: string; body: string | null; boostCount: number; commentCount: number; viewerCount: number; visibility: string; user: { username: string | null; name: string | null } | null } | null;

        if (rawPost && !rawPost.body?.trim()?.startsWith('[deleted]')) {
          topPost = {
            id: rawPost.id,
            body: rawPost.body ?? '',
            boostCount: rawPost.boostCount,
            commentCount: rawPost.commentCount,
            viewerCount: rawPost.viewerCount,
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
        username: string | null;
      };
      const topArticlesRaw = await this.prisma.article.findMany({
        where: {
          isDraft: false,
          deletedAt: null,
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
        username: a.author?.username ?? null,
      }));

      // Skip send if there's nothing at all to report.
      const totalActiveSubs = activePremiumCount + activePremiumPlusCount;
      const hasAnything =
        totalNewUserCount > 0 ||
        newFeedbackCount > 0 ||
        newReportCount > 0 ||
        newPostCount > 0 ||
        newArticleCount > 0 ||
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

      const dateLabel = windowStart.toLocaleDateString('en-US', {
        timeZone: ET_ZONE,
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });

      // Slack digest (fires regardless of email configuration).
      this.slack.notifyDailyDigest({
        dateLabel,
        totalNewUserCount,
        newPostCount,
        newArticleCount,
        activeUserCount,
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
          const html = this.buildHtml({
            dateLabel,
            now,
            baseUrl,
            newUsers,
            totalNewUserCount,
            newFeedbackCount,
            newReportCount,
            newPostCount,
            newArticleCount,
            activeUserCount,
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

          const text = this.buildText({
            dateLabel,
            totalNewUserCount,
            newFeedbackCount,
            newReportCount,
            newPostCount,
            newArticleCount,
            activeUserCount,
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
            const res = await this.email.sendEmail({ to: admin.email!, subject, text, html });
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

  private buildHtml(params: {
    dateLabel: string;
    now: Date;
    baseUrl: string;
    newUsers: UserRow[];
    totalNewUserCount: number;
    newFeedbackCount: number;
    newReportCount: number;
    newPostCount: number;
    newArticleCount: number;
    activeUserCount: number;
    bannedUserCount: number;
    pendingReportCount: number;
    unreviewedFeedbackCount: number;
    pendingVerificationCount: number;
    activePremiumCount: number;
    activePremiumPlusCount: number;
    pendingCancellationCount: number;
    newSubscriberRows: Array<{
      id: string;
      username: string | null;
      name: string | null;
      premium: boolean;
      premiumPlus: boolean;
      verifiedStatus: VerifiedStatus;
      isOrganization: boolean;
      stripeSubscriptionPriceId: string | null;
    }>;
    topPost: {
      id: string;
      body: string;
      boostCount: number;
      commentCount: number;
      viewerCount: number;
      visibility: string;
      username: string | null;
      name: string | null;
    } | null;
    topArticles: Array<{
      id: string;
      title: string;
      excerpt: string | null;
      boostCount: number;
      commentCount: number;
      viewCount: number;
      username: string | null;
    }>;
  }): string {
    const {
      dateLabel, now, baseUrl,
      newUsers, totalNewUserCount,
      newFeedbackCount, newReportCount, newPostCount, newArticleCount,
      activeUserCount, bannedUserCount,
      pendingReportCount, unreviewedFeedbackCount, pendingVerificationCount,
      activePremiumCount, activePremiumPlusCount, pendingCancellationCount,
      newSubscriberRows, topPost, topArticles,
    } = params;

    const sections: string[] = [];

    // ── Page header ──
    sections.push(
      `<h2 style="margin:0 0 4px 0;font-size:20px;font-weight:800;color:#111827;">Admin Daily Digest</h2>` +
      `<p style="margin:0 0 18px 0;font-size:13px;color:#6b7280;">${escapeHtml(dateLabel)}</p>`,
    );

    // ── New Members ──
    {
      const pill = totalNewUserCount > 0
        ? renderPill(String(totalNewUserCount), 'info')
        : renderPill('None', 'neutral');

      let body = '';
      if (totalNewUserCount === 0) {
        body = `<p style="margin:0;font-size:13px;color:#9ca3af;">No new members yesterday.</p>`;
      } else {
        body = newUsers.map((u) => renderNewUserRow(u, now, baseUrl)).join('');
        if (totalNewUserCount > newUsers.length) {
          body += `<p style="margin:8px 0 0 0;font-size:12px;color:#9ca3af;">…and ${totalNewUserCount - newUsers.length} more</p>`;
        }
        body += `<div style="margin-top:12px;">${renderButton({ href: `${baseUrl}/admin/users`, label: 'View All Users →', variant: 'secondary' })}</div>`;
      }

      sections.push(renderCard(sectionTitle('New Members', pill) + body));
    }

    // ── Yesterday's Activity ──
    {
      let body = '';
      body += renderStatRow('New posts published', newPostCount);
      body += renderStatRow('New articles published', newArticleCount);
      body += renderStatRow('Active users (sessions)', activeUserCount);
      if (bannedUserCount > 0) {
        body += renderStatRow('Users banned', bannedUserCount, { color: '#dc2626' });
      }
      sections.push(renderCard(sectionTitle("Yesterday's Activity") + body));
    }

    // ── Top Post of the Day ──
    if (topPost) {
      const postUrl = `${baseUrl}/p/${topPost.id}`;
      const authorName = topPost.name || topPost.username || 'Unknown';
      const authorHandle = topPost.username ? `@${topPost.username}` : '';
      const snippet = truncate(topPost.body, 220);

      const visibilityPill =
        topPost.visibility === 'verifiedOnly' ? renderPill('Verified only', 'info')
        : topPost.visibility === 'premiumOnly' ? renderPill('Premium only', 'warning')
        : '';

      const body =
        `<p style="margin:0 0 6px 0;font-size:12px;color:#6b7280;">` +
        `${escapeHtml(authorName)}${authorHandle ? ` <span style="color:#9ca3af;">${escapeHtml(authorHandle)}</span>` : ''}` +
        `${visibilityPill ? ` ${visibilityPill}` : ''}` +
        `</p>` +
        `<p style="margin:0 0 10px 0;font-size:13px;color:#374151;line-height:1.5;font-style:italic;">"${escapeHtml(snippet)}"</p>` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;"><tr>` +
        `<td style="padding-right:14px;font-size:12px;color:#6b7280;">🔁 ${topPost.boostCount} boosts</td>` +
        `<td style="padding-right:14px;font-size:12px;color:#6b7280;">💬 ${topPost.commentCount} replies</td>` +
        `<td style="font-size:12px;color:#6b7280;">👁 ${topPost.viewerCount} views</td>` +
        `</tr></table>` +
        renderButton({ href: postUrl, label: 'View Post →', variant: 'secondary' });

      sections.push(renderCard(sectionTitle('Top Post of the Day') + body));
    }

    // ── Top Articles of the Day ──
    if (topArticles.length > 0) {
      const body = [
        ...topArticles.map((article, idx) => {
          const articleUrl = `${baseUrl}/a/${article.id}`;
          const authorHandle = article.username ? `@${article.username}` : '@unknown';
          return [
            `<div style="${idx > 0 ? 'margin-top:10px;padding-top:10px;border-top:1px solid #f3f4f6;' : ''}">`,
            `<a href="${escapeHtml(articleUrl)}" style="font-size:14px;line-height:1.6;color:#111827;text-decoration:none;font-weight:700;">${escapeHtml(truncate(article.title || 'Untitled article', 140))}</a>`,
            `<div style="margin-top:4px;font-size:12px;color:#6b7280;">${escapeHtml(authorHandle)} · 👁 ${article.viewCount} · 🔁 ${article.boostCount} · 💬 ${article.commentCount}</div>`,
            article.excerpt
              ? `<div style="margin-top:4px;font-size:12px;line-height:1.6;color:#6b7280;">${escapeHtml(truncate(article.excerpt, 150))}</div>`
              : '',
            `</div>`,
          ].join('');
        }),
      ].join('');
      sections.push(renderCard(sectionTitle('Top Articles of the Day') + body));
    }

    // ── Revenue & Subscriptions ──
    {
      const totalActive = activePremiumCount + activePremiumPlusCount;
      const subBadge = totalActive > 0
        ? renderPill(`${totalActive} active`, 'success')
        : renderPill('None', 'neutral');

      let body = '';
      body += renderStatRow('Active Premium subscribers', activePremiumCount, { dimZero: true });
      body += renderStatRow('Active Premium+ subscribers', activePremiumPlusCount, { dimZero: true });
      body += renderStatRow('New subscribers yesterday', newSubscriberRows.length, {
        color: newSubscriberRows.length > 0 ? '#059669' : undefined,
        dimZero: true,
      });
      if (pendingCancellationCount > 0) {
        body += renderStatRow('Cancelling at period end', pendingCancellationCount, { color: '#d97706' });
      }

      // Mini list of new subscribers
      if (newSubscriberRows.length > 0) {
        body += `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #f3f4f6;">`;
        body += `<div style="font-size:11px;font-weight:600;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.06em;">New yesterday</div>`;
        for (const sub of newSubscriberRows) {
          const displayName = sub.name || sub.username || '(no name)';
          const handle = sub.username ? ` @${sub.username}` : '';
          const badge = renderTierBadge(sub);
          body += `<div style="font-size:12px;color:#374151;padding:3px 0;">${escapeHtml(displayName)}${escapeHtml(handle)}${badge ? ` ${badge}` : ''}</div>`;
        }
        body += `</div>`;
      }

      sections.push(renderCard(sectionTitle('Revenue & Subscriptions', subBadge) + body));
    }

    // ── New Feedbacks ──
    {
      const pill = newFeedbackCount > 0
        ? renderPill(String(newFeedbackCount), 'warning')
        : renderPill('None', 'neutral');

      let body = '';
      if (newFeedbackCount === 0) {
        body = `<p style="margin:0;font-size:13px;color:#9ca3af;">No new feedback submissions yesterday.</p>`;
      } else {
        body =
          `<p style="margin:0 0 12px 0;font-size:13px;color:#374151;">${plural(newFeedbackCount, 'new submission')} received.</p>` +
          renderButton({ href: `${baseUrl}/admin/feedback`, label: 'Review Feedbacks →', variant: 'secondary' });
      }

      sections.push(renderCard(sectionTitle('New Feedbacks', pill) + body));
    }

    // ── New Reports ──
    {
      const pill = newReportCount > 0
        ? renderPill(String(newReportCount), 'warning')
        : renderPill('None', 'neutral');

      let body = '';
      if (newReportCount === 0) {
        body = `<p style="margin:0;font-size:13px;color:#9ca3af;">No new reports submitted yesterday.</p>`;
      } else {
        body =
          `<p style="margin:0 0 12px 0;font-size:13px;color:#374151;">${plural(newReportCount, 'new report')} submitted.</p>` +
          renderButton({ href: `${baseUrl}/admin/reports`, label: 'Review Reports →', variant: 'secondary' });
      }

      sections.push(renderCard(sectionTitle('New Reports', pill) + body));
    }

    // ── Open Backlog (only if any) ──
    const hasBacklog = pendingReportCount > 0 || unreviewedFeedbackCount > 0 || pendingVerificationCount > 0;
    if (hasBacklog) {
      let body = '';
      if (pendingReportCount > 0) {
        body += renderStatRow('Pending reports (total)', pendingReportCount, {
          href: `${baseUrl}/admin/reports`,
          color: '#dc2626',
        });
      }
      if (unreviewedFeedbackCount > 0) {
        body += renderStatRow('Unreviewed feedbacks (total)', unreviewedFeedbackCount, {
          href: `${baseUrl}/admin/feedback`,
          color: '#d97706',
        });
      }
      if (pendingVerificationCount > 0) {
        body += renderStatRow('Pending verifications (total)', pendingVerificationCount, {
          href: `${baseUrl}/admin/verification`,
          color: '#2563eb',
        });
      }
      sections.push(renderCard(sectionTitle('Open Backlog', renderPill('Needs attention', 'warning')) + body));
    }

    // ── Preheader ──
    const preheaderParts: string[] = [];
    if (totalNewUserCount > 0) preheaderParts.push(plural(totalNewUserCount, 'new member'));
    if (newSubscriberRows.length > 0) preheaderParts.push(plural(newSubscriberRows.length, 'new subscriber'));
    if (newReportCount > 0) preheaderParts.push(plural(newReportCount, 'new report'));
    if (newFeedbackCount > 0) preheaderParts.push(plural(newFeedbackCount, 'new feedback'));
    if (newPostCount > 0) preheaderParts.push(plural(newPostCount, 'new post'));
    if (newArticleCount > 0) preheaderParts.push(plural(newArticleCount, 'new article'));
    const preheader = preheaderParts.length > 0 ? preheaderParts.join(' · ') : 'Daily admin summary';

    return renderMohEmail({
      title: 'Admin Digest',
      preheader,
      contentHtml: sections.join(''),
      footerHtml: 'Men of Hunger — Admin',
    });
  }

  // ─── Plain-text fallback ──────────────────────────────────────────────────

  private buildText(params: {
    dateLabel: string;
    totalNewUserCount: number;
    newFeedbackCount: number;
    newReportCount: number;
    newPostCount: number;
    newArticleCount: number;
    activeUserCount: number;
    bannedUserCount: number;
    pendingReportCount: number;
    unreviewedFeedbackCount: number;
    pendingVerificationCount: number;
    activePremiumCount: number;
    activePremiumPlusCount: number;
    pendingCancellationCount: number;
    newSubscriberCount: number;
    topPost: { id: string; body: string; username: string | null; boostCount: number; commentCount: number } | null;
    topArticles: Array<{ id: string; title: string; username: string | null; boostCount: number; commentCount: number; viewCount: number }>;
    baseUrl: string;
  }): string {
    const {
      dateLabel, totalNewUserCount, newFeedbackCount, newReportCount,
      newPostCount, newArticleCount, activeUserCount, bannedUserCount,
      pendingReportCount, unreviewedFeedbackCount, pendingVerificationCount,
      activePremiumCount, activePremiumPlusCount, pendingCancellationCount,
      newSubscriberCount, topPost, topArticles, baseUrl,
    } = params;

    const lines: string[] = [
      `Admin Daily Digest — ${dateLabel}`,
      '',
      '── Yesterday ──────────────────────',
      `New members:   ${totalNewUserCount}`,
      `New posts:     ${newPostCount}`,
      `New articles:  ${newArticleCount}`,
      `Active users:  ${activeUserCount}`,
    ];

    if (bannedUserCount > 0) lines.push(`Users banned:  ${bannedUserCount}`);

    lines.push('');
    lines.push('── Revenue & Subscriptions ────────');
    lines.push(`Active Premium:    ${activePremiumCount}`);
    lines.push(`Active Premium+:   ${activePremiumPlusCount}`);
    lines.push(`New subscribers:   ${newSubscriberCount}`);
    if (pendingCancellationCount > 0) lines.push(`Cancelling:        ${pendingCancellationCount}`);

    if (topPost) {
      lines.push('');
      lines.push('── Top Post of the Day ────────────');
      if (topPost.username) lines.push(`@${topPost.username}`);
      lines.push(truncate(topPost.body, 200));
      lines.push(`Boosts: ${topPost.boostCount}  Replies: ${topPost.commentCount}`);
      lines.push(`${baseUrl}/p/${topPost.id}`);
    }
    if (topArticles.length > 0) {
      lines.push('');
      lines.push('── Top Articles of the Day ─────────');
      for (const [idx, article] of topArticles.entries()) {
        const handle = article.username ? `@${article.username}` : '@unknown';
        lines.push(`${idx + 1}. ${truncate(article.title, 140)} (${handle})`);
        lines.push(`   👁 ${article.viewCount}  🔁 ${article.boostCount}  💬 ${article.commentCount}`);
        lines.push(`   ${baseUrl}/a/${article.id}`);
      }
    }

    lines.push('');
    lines.push('── New Submissions ─────────────────');
    lines.push(`Feedbacks:  ${newFeedbackCount}  ${baseUrl}/admin/feedback`);
    lines.push(`Reports:    ${newReportCount}  ${baseUrl}/admin/reports`);

    if (pendingReportCount > 0 || unreviewedFeedbackCount > 0 || pendingVerificationCount > 0) {
      lines.push('');
      lines.push('── Open Backlog ─────────────────────');
      if (pendingReportCount > 0) lines.push(`Pending reports:        ${pendingReportCount}  ${baseUrl}/admin/reports`);
      if (unreviewedFeedbackCount > 0) lines.push(`Unreviewed feedbacks:   ${unreviewedFeedbackCount}  ${baseUrl}/admin/feedback`);
      if (pendingVerificationCount > 0) lines.push(`Pending verifications:  ${pendingVerificationCount}  ${baseUrl}/admin/verification`);
    }

    lines.push('', 'Men of Hunger — Admin');
    return lines.join('\n');
  }
}
