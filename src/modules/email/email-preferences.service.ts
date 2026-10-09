import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL, EMAIL_CLASS } from './templates/moh-email';
import { EMAIL_PREFERENCES, type EmailPreference, type SendEmailParams } from './email-delivery.types';

const LABELS: Record<EmailPreference, string> = {
  emailDigestWeekly: 'weekly digests', emailNewNotifications: 'activity reminders',
  emailInstantHighSignal: 'messages, mentions and replies', emailStreakReminder: 'check-in reminders',
  emailFollowedArticle: 'article and Space updates', emailOnboarding: 'getting-started tips', emailNewsletter: 'lodge newsletters',
};

@Injectable()
export class EmailPreferencesService {
  constructor(private readonly prisma: PrismaService, private readonly config: AppConfigService) {}

  recipientHash(email: string): string {
    return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  }

  async blockedReason(req: SendEmailParams): Promise<string | null> {
    const suppressed = await this.prisma.emailSuppression.findUnique({ where: { recipientHash: this.recipientHash(req.to) } });
    if (suppressed) return 'email_suppressed';
    if (!req.userId) return req.preference ? 'email_user_required' : null;
    const user = await this.prisma.user.findUnique({
      where: { id: req.userId },
      select: { email: true, emailVerifiedAt: true, bannedAt: true, deletionRequestedAt: true, notificationPreferences: true },
    });
    if (!user || user.bannedAt || user.deletionRequestedAt) return 'email_recipient_inactive';
    if (req.recipientMode === 'previous' && req.category !== 'transactional') return 'email_invalid_recipient_mode';
    if (req.recipientMode !== 'previous') {
      if (user.email?.trim().toLowerCase() !== req.to.trim().toLowerCase()) return 'email_recipient_changed';
      if (req.recipientMode !== 'verification' && !user.emailVerifiedAt) return 'email_recipient_unverified';
    }
    if (req.preference && user.notificationPreferences?.[req.preference] === false) return 'email_preference_disabled';
    return null;
  }

  private signature(payload: string): string {
    return createHmac('sha256', this.config.sessionHmacSecret()).update(`email-family:${payload}`).digest('base64url');
  }

  unsubscribeToken(userId: string, email: string, preference: EmailPreference): string {
    const payload = Buffer.from(JSON.stringify({ userId, hash: this.recipientHash(email), preference })).toString('base64url');
    return `family.${payload}.${this.signature(payload)}`;
  }

  async unsubscribe(token: string): Promise<{ ok: true; family: string }> {
    const [prefix, payload, signature, extra] = token.split('.');
    if (prefix !== 'family' || !payload || !signature || extra) throw new BadRequestException('Invalid unsubscribe link.');
    const actual = Buffer.from(signature);
    const expected = Buffer.from(this.signature(payload));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BadRequestException('Invalid unsubscribe link.');
    let data: { userId?: unknown; hash?: unknown; preference?: unknown };
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new BadRequestException('Invalid unsubscribe link.'); }
    if (typeof data.userId !== 'string' || typeof data.hash !== 'string' || !EMAIL_PREFERENCES.includes(data.preference as EmailPreference)) throw new BadRequestException('Invalid unsubscribe link.');
    const preference = data.preference as EmailPreference;
    const user = await this.prisma.user.findUnique({ where: { id: data.userId }, select: { email: true } });
    // A link for an older address cannot change the preferences of its replacement.
    if (!user?.email || this.recipientHash(user.email) !== data.hash) throw new BadRequestException('This unsubscribe link is no longer valid.');
    await this.prisma.notificationPreferences.upsert({
      where: { userId: data.userId }, create: { userId: data.userId, [preference]: false }, update: { [preference]: false },
    });
    return { ok: true, family: LABELS[preference] };
  }

  decorate(req: SendEmailParams): SendEmailParams {
    if (!req.userId || !req.preference) return req;
    const token = this.unsubscribeToken(req.userId, req.to, req.preference);
    const url = `${this.config.emailPublicApiUrl()}/email/unsubscribe?token=${encodeURIComponent(token)}`;
    const label = `Unsubscribe from ${LABELS[req.preference]}`;
    const footer = `<div class="${EMAIL_CLASS.muted}" style="max-width:600px;margin:0 auto;padding:12px;text-align:center;font-size:12px;line-height:1.6;color:${EMAIL.muted};"><a class="${EMAIL_CLASS.muted}" href="${url}" style="color:${EMAIL.muted};text-decoration:underline;">${label}</a></div>`;
    return { ...req, text: `${req.text}\n\n${label}: ${url}`, html: req.html ? (/<\/body>/i.test(req.html) ? req.html.replace(/<\/body>/i, `${footer}</body>`) : `${req.html}${footer}`) : req.html,
      headers: { ...req.headers, 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
  }
}
