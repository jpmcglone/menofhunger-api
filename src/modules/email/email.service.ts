import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import type { EmailSendRequest, EmailSendResult } from './providers/email-provider';
import { ResendEmailProvider } from './providers/resend-email.provider';
import { EmailBudgetService } from './email-budget.service';

import { Cron } from '@nestjs/schedule';
import { EmailDeliveryService, emailPayloadFingerprint } from './email-delivery.service';
import { EmailPreferencesService } from './email-preferences.service';
import type { EmailCategory, SendEmailParams } from './email-delivery.types';
export type { EmailCategory, EmailPreference, SendEmailParams } from './email-delivery.types';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly resend: ResendEmailProvider,
    private readonly appConfig: AppConfigService,
    private readonly budget: EmailBudgetService,
    private readonly delivery: EmailDeliveryService,
    private readonly preferences: EmailPreferencesService,
  ) {}

  async sendText(params: SendEmailParams): Promise<EmailSendResult> {
    // NOTE: `sendEmail()` applies dev-only normalization.
    // Avoid normalizing twice (which can duplicate banners/prefixes).
    const res = await this.sendEmail(params);
    return res;
  }

  async sendEmail(req: SendEmailParams): Promise<EmailSendResult> {
    if (await this.delivery.alreadySent(req.eventKey)) return { sent: true };
    const category: EmailCategory = req.category ?? 'engagement';
    const blocked = await this.preferences.blockedReason(req);
    if (blocked) return { sent: false, reason: blocked };
    // Decorate once and keep the exact provider payload immutable for idempotent retries.
    const normalized = this.normalizeForDev(this.preferences.decorate({ ...req, category, from: req.from || this.appConfig.email()?.fromEmail.default }));
    const row = await this.delivery.prepare(normalized);
    if (['sent', 'delivered'].includes(row.status)) return { sent: true };
    if (!(await this.delivery.claim(row))) return { sent: false, reason: 'email_already_claimed', retryable: row.retryUntil.getTime() > Date.now() && row.attempts < 6 && !['failed', 'suppressed', 'bounced', 'complained'].includes(row.status) };
    const persisted = JSON.parse(row.requestJson!) as SendEmailParams;
    const stale = await this.preferences.blockedReason(persisted);
    if (stale) {
      const result: EmailSendResult = { sent: false, reason: stale };
      await this.delivery.finish(row, result, persisted);
      return result;
    }
    // Caller-managed retries revalidate the event and access, but cannot silently
    // reuse stale private content. Resend also requires an identical body per key.
    if (!row.retrySafe && emailPayloadFingerprint(normalized) !== emailPayloadFingerprint(persisted)) {
      const result: EmailSendResult = { sent: false, reason: 'email_content_changed' };
      await this.delivery.finish(row, result, persisted);
      return result;
    }
    const budget = await this.budget.reserve(persisted.category ?? category, persisted.userId ?? null, row.id);
    if (!budget.allowed) {
      const result: EmailSendResult = { sent: false, reason: budget.reason ?? 'email_quota_exceeded', retryable: true };
      await this.delivery.finish(row, result, persisted);
      return result;
    }
    const result = await this.resend.sendEmail({ ...persisted, idempotencyKey: this.delivery.providerKey(row) });
    await this.budget.reconcile(budget, result).catch(() => this.logger.warn('Email budget reconciliation deferred.'));
    await this.delivery.finish(row, result, persisted);
    return result;
  }

  @Cron('*/2 * * * *')
  async retryPending(): Promise<void> {
    if (!this.appConfig.runSchedulers() || !this.appConfig.email()) return;
    for (const row of await this.delivery.due()) {
      if (!row.requestJson) continue;
      const req = JSON.parse(row.requestJson) as SendEmailParams;
      if (!(await this.delivery.claim(row))) continue;
      const blocked = await this.preferences.blockedReason(req);
      if (blocked) {
        await this.delivery.finish(row, { sent: false, reason: blocked }, req);
        continue;
      }
      const budget = await this.budget.reserve(req.category ?? 'engagement', req.userId ?? null, row.id);
      if (!budget.allowed) {
        await this.delivery.finish(row, { sent: false, reason: budget.reason!, retryable: true }, req);
        continue;
      }
      const result = await this.resend.sendEmail({ ...req, idempotencyKey: this.delivery.providerKey(row) });
      await this.budget.reconcile(budget, result).catch(() => this.logger.warn('Email budget reconciliation deferred.'));
      await this.delivery.finish(row, result, req);
    }
  }

  async broadcastRemaining(): Promise<number> {
    return this.budget.broadcastRemaining();
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

