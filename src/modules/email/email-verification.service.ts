import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from './email.service';
import { AppConfigService } from '../app/app-config.service';
import { EmailActionTokensService } from './email-action-tokens.service';
import { escapeHtml, renderButton, renderCard, renderMohEmail, renderPill } from './templates/moh-email';

const VERIFY_EXPIRES_HOURS = 48;
// Protect deliverability + cost: prevent hammering resend.
// UX requirement: cooldown should persist across refresh (based on stored requestedAt).
const RESEND_COOLDOWN_SECONDS = 30;

function safeBaseUrl(raw: string | null): string {
  const base = (raw ?? '').trim() || 'https://menofhunger.com';
  return base.replace(/\/$/, '');
}

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly tokens: EmailActionTokensService,
    private readonly email: EmailService,
  ) {}

  async requestVerification(params: { userId: string; email: string; name?: string | null }): Promise<{ sent: boolean }> {
    const to = (params.email ?? '').trim().toLowerCase();
    if (!to) throw new BadRequestException('Email is required.');

    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (!user) throw new BadRequestException('User not found.');
    if (!user.email || user.email.toLowerCase() !== to) {
      throw new BadRequestException('Email does not match current email.');
    }
    if (user.emailVerifiedAt) return { sent: true };

    // Invalidate prior tokens for this purpose.
    await this.tokens.invalidateAll({ userId: user.id, purpose: 'verifyEmail' });

    const expiresAt = new Date(Date.now() + VERIFY_EXPIRES_HOURS * 60 * 60 * 1000);
    const issued = await this.tokens.issue({ userId: user.id, purpose: 'verifyEmail', email: to, expiresAt });

    // Mark requestedAt (best-effort; don't block email).
    try {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerificationRequestedAt: new Date() },
      });
    } catch {
      // ignore
    }

    const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
    // Frontend route (no /api): page will require login and call API to confirm.
    const confirmUrl = `${baseUrl}/email/verify?token=${encodeURIComponent(issued.token)}`;

    const greetingName = (params.name ?? '').trim();
    const greeting = greetingName ? `Hey ${greetingName},` : 'Hey,';

    const text = [
      greeting,
      '',
      'Please verify your email address for Men of Hunger.',
      '',
      `Verify: ${confirmUrl}`,
      '',
      `This link expires in ${VERIFY_EXPIRES_HOURS} hours.`,
    ].join('\n');

    const previewText = `Verify your email to receive digests and notifications.`;
    const safeConfirmUrl = escapeHtml(confirmUrl);
    const html = renderMohEmail({
      title: 'Verify your email',
      preheader: previewText,
      contentHtml: [
        `<div style="font-size:20px;font-weight:900;line-height:1.25;margin:0 0 8px 0;color:#111827;">Verify your email</div>`,
        `<div style="margin:0 0 12px 0;font-size:14px;line-height:1.7;color:#374151;">${escapeHtml(greeting)}</div>`,
        renderCard(
          [
            `<div style="font-size:14px;line-height:1.7;color:#111827;">Confirm this email address to unlock your daily digest and important notifications.</div>`,
            `<div style="margin-top:12px;">${renderButton({ href: confirmUrl, label: 'Verify email', variant: 'primary' })}</div>`,
            `<div style="margin-top:12px;">${renderPill(`Expires in ${VERIFY_EXPIRES_HOURS} hours`, 'warning')}</div>`,
          ].join(''),
        ),
        `<div style="margin-top:14px;font-size:12px;line-height:1.7;color:#6b7280;">If the button doesn’t work, copy and paste this link:</div>`,
        `<div style="margin-top:6px;font-size:12px;line-height:1.7;word-break:break-all;"><a href="${safeConfirmUrl}" style="color:#111827;text-decoration:underline;">${safeConfirmUrl}</a></div>`,
        `<hr style="border:0;border-top:1px solid #e5e7eb;margin:18px 0;" />`,
        `<div style="font-size:12px;line-height:1.7;color:#6b7280;">Didn’t request this? You can safely ignore this email.</div>`,
      ].join(''),
      footerHtml: `Men of Hunger · Security notice: verification requires login.`,
    });

    const sent = await this.email.sendText({
      to,
      subject: 'Verify your email',
      text,
      html,
      from: this.appConfig.email()?.fromEmail.support ?? undefined,
    });
    if (!sent.sent) {
      this.logger.warn(`[verify] email not sent userId=${user.id} reason=${sent.reason ?? 'unknown'}`);
      return { sent: false };
    }
    return { sent: true };
  }

  async resendForUser(userId: string): Promise<{ sent: boolean; reason?: string; retryAfterSeconds?: number }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        username: true,
        emailVerifiedAt: true,
        emailVerificationRequestedAt: true,
      },
    });
    if (!user) throw new BadRequestException('User not found.');
    const email = (user.email ?? '').trim();
    if (!email) throw new BadRequestException('Email is required.');
    if (user.emailVerifiedAt) return { sent: false, reason: 'already_verified' };

    const last = user.emailVerificationRequestedAt;
    if (last) {
      const ms = Date.now() - last.getTime();
      const cooldownMs = RESEND_COOLDOWN_SECONDS * 1000;
      if (ms < cooldownMs) {
        const remaining = Math.max(1, Math.ceil((cooldownMs - ms) / 1000));
        return { sent: false, reason: 'cooldown', retryAfterSeconds: remaining };
      }
    }

    const name = (user.name ?? user.username ?? '').trim() || null;
    const res = await this.requestVerification({ userId: user.id, email, name });
    return { sent: Boolean(res.sent), reason: res.sent ? 'sent' : 'send_failed' };
  }

  async confirmForUser(params: { userId: string; token: string }): Promise<{ ok: boolean; reason?: string }> {
    const userId = (params.userId ?? '').trim();
    if (!userId) return { ok: false, reason: 'user_missing' };
    const raw = (params.token ?? '').trim();
    if (!raw) return { ok: false, reason: 'token_missing' };

    const row = await this.tokens.consume({ purpose: 'verifyEmail', token: raw, userId });
    if (!row) return { ok: false, reason: 'token_invalid' };

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!user || !user.email) return { ok: false, reason: 'user_missing' };
    if (row.email && user.email.toLowerCase() !== row.email.toLowerCase()) {
      return { ok: false, reason: 'email_changed' };
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });
    return { ok: true };
  }
}
