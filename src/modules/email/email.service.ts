import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import type { EmailSendRequest, EmailSendResult } from './providers/email-provider';
import { ResendEmailProvider } from './providers/resend-email.provider';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';

/**
 * 'transactional' — must-send email (verification). Counts toward total but
 *   is never blocked by the engagement budget; only blocked at the hard quota wall.
 * 'engagement' — optional reminder email (digest, nudges, instant, streak).
 *   Blocked once sends reach (quotaLimit - verificationReserve).
 *   Also enforces a per-user 24h cap so one active user can't drain the team quota.
 * 'broadcast' — admin newsletter blast. Own daily quota; no per-user 24h cap.
 */
export type EmailCategory = 'transactional' | 'engagement' | 'broadcast';

type SendEmailParams = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** Defaults to 'engagement'. Pass 'transactional' for verification emails. */
  category?: EmailCategory;
  /** Required when category is 'engagement' to enforce the per-user 24h cap. */
  userId?: string;
};

const DAILY_COUNT_TTL_MS = 48 * 60 * 60 * 1000;
const PER_USER_CAP_TTL_MS = 26 * 60 * 60 * 1000;

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly resend: ResendEmailProvider,
    private readonly appConfig: AppConfigService,
    private readonly redis: RedisService,
  ) {}

  async sendText(params: SendEmailParams): Promise<{ sent: boolean; reason?: string }> {
    // NOTE: `sendEmail()` applies dev-only normalization.
    // Avoid normalizing twice (which can duplicate banners/prefixes).
    const res = await this.sendEmail({
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
      from: params.from,
      replyTo: params.replyTo,
      headers: params.headers,
      category: params.category,
      userId: params.userId,
    });
    return res.sent ? { sent: true } : { sent: false, reason: res.reason };
  }

  async sendEmail(req: EmailSendRequest & { category?: EmailCategory; userId?: string }): Promise<EmailSendResult> {
    const category: EmailCategory = req.category ?? 'engagement';
    const userId = req.userId ?? null;

    // Budget check before sending.
    const budget = await this.checkBudget(category, userId);
    if (!budget.allowed) {
      const reason = budget.reason ?? 'email_quota_exceeded';
      this.logger.warn(`[email-quota] blocked send category=${category} userId=${userId ?? 'n/a'} reason=${reason}`);
      return { sent: false, reason };
    }

    const normalized = this.normalizeForDev(req);
    // Provider selection stays centralized here so swapping providers later is trivial.
    // For now, Resend is the only supported provider.
    const result = await this.resend.sendEmail(normalized);

    if (result.sent) {
      // Track the send against the team daily counter.
      await this.recordSend(category, userId).catch(() => undefined);
    }

    return result;
  }

  /**
   * Checks the team daily budget and (for engagement) the per-user 24h cap.
   * Returns { allowed: true } when the send may proceed, or { allowed: false, reason } when blocked.
   * Logs an upgrade hint when engagement sends exhaust the budget.
   */
  private async checkBudget(
    category: EmailCategory,
    userId: string | null,
  ): Promise<{ allowed: boolean; reason?: string }> {
    try {
      const dailyLimit = this.appConfig.emailDailyQuotaLimit();
      const reserve = this.appConfig.emailDailyVerificationReserve();
      const engagementCap = dailyLimit - reserve;

      const countKey = RedisKeys.emailDailyCount(utcDateKey());
      const raw = await this.redis.getString(countKey);
      const count = Number(raw ?? '0');

      if (category === 'transactional') {
        if (count >= dailyLimit) {
          this.logger.error(
            `[email-quota] HARD LIMIT REACHED: ${count}/${dailyLimit} sends today. Verification email blocked. Upgrade Resend to remove the daily cap.`,
          );
          return { allowed: false, reason: 'email_quota_hard_limit' };
        }
        return { allowed: true };
      }

      if (category === 'broadcast') {
        const broadcastLimit = this.appConfig.emailBroadcastDailyQuota();
        const broadcastKey = RedisKeys.emailBroadcastDailyCount(utcDateKey());
        const broadcastRaw = await this.redis.getString(broadcastKey);
        const broadcastCount = Number(broadcastRaw ?? '0');
        if (broadcastCount >= broadcastLimit) {
          this.logger.warn(
            `[email-quota] Broadcast budget exhausted (${broadcastCount}/${broadcastLimit}). Pausing newsletter send.`,
          );
          return { allowed: false, reason: 'email_quota_broadcast_limit' };
        }
        return { allowed: true };
      }

      // Engagement: block at (limit - reserve).
      if (count >= engagementCap) {
        this.logger.warn(
          `[email-quota] Engagement budget exhausted (${count}/${dailyLimit}, reserve=${reserve}). Skipping engagement email. ` +
            `If this is happening 3+ days/week, it is time to upgrade Resend.`,
        );
        return { allowed: false, reason: 'email_quota_engagement_limit' };
      }

      // Per-user 24h engagement cap.
      if (userId) {
        const userCapKey = RedisKeys.emailLastEngagement(userId);
        const lastSentRaw = await this.redis.getString(userCapKey);
        if (lastSentRaw) {
          return { allowed: false, reason: 'email_per_user_engagement_cap' };
        }
      }

      return { allowed: true };
    } catch {
      // Redis unavailable: allow the send rather than silently dropping all email.
      return { allowed: true };
    }
  }

  /**
   * Records a successful send in the team daily counter and, for engagement emails,
   * marks the per-user 24h cap.
   */
  async broadcastRemaining(): Promise<number> {
    try {
      const limit = this.appConfig.emailBroadcastDailyQuota();
      const raw = await this.redis.getString(RedisKeys.emailBroadcastDailyCount(utcDateKey()));
      const count = Number(raw ?? '0');
      return Math.max(0, limit - (Number.isFinite(count) ? count : 0));
    } catch {
      return this.appConfig.emailBroadcastDailyQuota();
    }
  }

  private async recordSend(category: EmailCategory, userId: string | null): Promise<void> {
    if (category === 'broadcast') {
      const broadcastKey = RedisKeys.emailBroadcastDailyCount(utcDateKey());
      await this.redis.raw().incr(broadcastKey);
      await this.redis.raw().pexpire(broadcastKey, DAILY_COUNT_TTL_MS);
      return;
    }

    const countKey = RedisKeys.emailDailyCount(utcDateKey());
    await this.redis.raw().incr(countKey);
    // Keep counter for 48h so it survives past midnight for debugging.
    await this.redis.raw().pexpire(countKey, DAILY_COUNT_TTL_MS);

    if (category === 'engagement' && userId) {
      const userCapKey = RedisKeys.emailLastEngagement(userId);
      await this.redis.setString(userCapKey, String(Date.now()), { ttlMs: PER_USER_CAP_TTL_MS });
    }
  }

  private normalizeForDev<T extends EmailSendRequest>(req: T): T {
    if (this.appConfig.isProd()) return req;

    const subject = (req.subject ?? '').trim();
    const prefixedSubject = subject.startsWith('Dev - Men of Hunger')
      ? subject
      : `Dev - Men of Hunger${subject ? ` - ${subject}` : ''}`;

    const text = (req.text ?? '').trim();
    const prefixedText = text.startsWith('Dev - Men of Hunger')
      ? text
      : `Dev - Men of Hunger\n\n${text}`;

    const html = (req.html ?? '').trim();
    if (!html) {
      return { ...req, subject: prefixedSubject, text: prefixedText };
    }

    // Make dev banner injection idempotent (avoid duplicates if normalize is applied twice).
    const alreadyHasDevBanner =
      /data-moh-dev-banner=(?:"|')1(?:"|')/i.test(html) || /Dev\s*-\s*Men\s+of\s+Hunger<\/div>/i.test(html);
    if (alreadyHasDevBanner) {
      return { ...req, subject: prefixedSubject, text: prefixedText, html };
    }

    const bannerHtml =
      '<div data-moh-dev-banner="1" style="width:100%;max-width:600px;margin:12px auto 0 auto;padding:8px 12px;border:1px solid #f59e0b;border-radius:10px;background:#fffbeb;color:#92400e;font-size:12px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;text-align:center;">Dev - Men of Hunger</div>';
    const htmlWithBanner = html.replace(/(<body\b[^>]*>)/i, `$1${bannerHtml}`);

    return { ...req, subject: prefixedSubject, text: prefixedText, html: htmlWithBanner };
  }
}

