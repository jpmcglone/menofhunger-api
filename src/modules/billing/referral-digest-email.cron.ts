import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AppConfigService } from '../app/app-config.service';
import { escapeHtml, renderMohEmail } from '../email/templates/moh-email';
import { getRecipientEmail, buildGreeting } from '../email/email-send.helpers';

function safeBaseUrl(raw: string | null): string {
  return (raw ?? '').trim().replace(/\/$/, '') || 'https://menofhunger.com';
}

@Injectable()
export class ReferralDigestEmailCron {
  private readonly logger = new Logger(ReferralDigestEmailCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly appConfig: AppConfigService,
  ) {}

  /** Runs every day at 9 AM UTC. */
  @Cron('0 9 * * *')
  async sendDailyReferralDigests(): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Find all recruits that joined in the last 24 h.
    const newRecruits = await this.prisma.user.findMany({
      where: {
        recruitedById: { not: null },
        createdAt: { gte: since },
      },
      select: {
        id: true,
        username: true,
        name: true,
        recruitedById: true,
      },
    });

    if (newRecruits.length === 0) return;

    // Group by recruiter id.
    const byRecruiter = new Map<string, typeof newRecruits>();
    for (const recruit of newRecruits) {
      const rid = recruit.recruitedById!;
      if (!byRecruiter.has(rid)) byRecruiter.set(rid, []);
      byRecruiter.get(rid)!.push(recruit);
    }

    // Fetch recruiters who have an email address (verified or not — we send to any on-file email).
    const recruiterIds = [...byRecruiter.keys()];
    const recruiters = await this.prisma.user.findMany({
      where: { id: { in: recruiterIds } },
      select: { id: true, username: true, name: true, email: true },
    });

    const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
    let sent = 0;

    for (const recruiter of recruiters) {
      const to = getRecipientEmail(recruiter.email);
      if (!to) continue;

      const recruits = byRecruiter.get(recruiter.id) ?? [];
      if (recruits.length === 0) continue;

      const count = recruits.length;
      const plural = count === 1 ? 'person' : 'people';
      const greeting = buildGreeting({ name: recruiter.name, username: recruiter.username });

      const recruitListHtml = recruits
        .map((r) => {
          const display = escapeHtml(r.name ?? r.username ?? 'Someone');
          const profileUrl = r.username
            ? `${baseUrl}/u/${encodeURIComponent(r.username)}`
            : `${baseUrl}/u/`;
          return `<tr>
  <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
    <a href="${escapeHtml(profileUrl)}" style="font-weight:600;color:#111827;text-decoration:none;">${display}</a>
    ${r.username ? `<span style="font-size:12px;color:#6b7280;"> @${escapeHtml(r.username)}</span>` : ''}
  </td>
  <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;text-align:right;">
    <a href="${escapeHtml(profileUrl)}" style="font-size:12px;color:#2563eb;text-decoration:none;">View profile →</a>
  </td>
</tr>`;
        })
        .join('');

      const contentHtml = `
<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#111827;">${escapeHtml(greeting)}</p>
<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#111827;">
  <strong>${count} ${plural}</strong> signed up with your referral code today. Keep sharing it — when they go premium you both earn a free month.
</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
       style="border-collapse:collapse;width:100%;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
  <thead>
    <tr style="background:#f9fafb;">
      <th style="padding:8px 12px;text-align:left;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">New recruit</th>
      <th style="padding:8px 12px;text-align:right;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;"></th>
    </tr>
  </thead>
  <tbody style="background:#ffffff;padding:0 12px;">
    ${recruitListHtml}
  </tbody>
</table>
<p style="margin:20px 0 0 0;font-size:13px;color:#6b7280;line-height:1.6;">
  Your referral code: <strong style="font-family:monospace;color:#111827;">${escapeHtml(recruiter.username ?? '—')}</strong>
  &nbsp;·&nbsp;
  <a href="${escapeHtml(`${baseUrl}/settings/billing`)}" style="color:#2563eb;">Manage in settings</a>
</p>`;

      const subject =
        count === 1
          ? `1 new recruit joined with your referral code`
          : `${count} new recruits joined with your referral code`;

      const html = renderMohEmail({
        title: subject,
        preheader: `${count} ${plural} signed up on Men of Hunger using your referral code today.`,
        contentHtml,
      });

      const result = await this.email.sendEmail({
        to,
        subject,
        text: `${greeting}\n\n${count} ${plural} signed up with your referral code today.\n\n${recruits.map((r) => `• ${r.name ?? r.username ?? 'Someone'}${r.username ? ` (@${r.username}) — ${baseUrl}/u/${r.username}` : ''}`).join('\n')}\n\nManage referrals: ${baseUrl}/settings/billing`,
        html,
      });

      if (result.sent) {
        sent++;
      } else {
        this.logger.warn(`[referral-digest] Failed to send to recruiter ${recruiter.id}: ${result.reason}`);
      }
    }

    this.logger.log(`[referral-digest] Sent ${sent}/${recruiterIds.length} digest emails for ${newRecruits.length} new recruits`);
  }
}
