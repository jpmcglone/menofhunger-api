import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../app/app-config.service';
import type { EmailProvider, EmailSendRequest, EmailSendResult } from './email-provider';

type ResendSendEmailResponseOk = {
  id: string;
};

@Injectable()
export class ResendEmailProvider implements EmailProvider {
  private readonly logger = new Logger(ResendEmailProvider.name);

  constructor(private readonly appConfig: AppConfigService) {}

  async sendEmail(req: EmailSendRequest): Promise<EmailSendResult> {
    const cfg = this.appConfig.email();
    if (!cfg) return { sent: false, reason: 'email_not_configured', definitiveRejection: true };
    if (cfg.provider !== 'resend') return { sent: false, reason: 'email_provider_not_supported', definitiveRejection: true };

    const to = (req.to ?? '').trim();
    const subject = (req.subject ?? '').trim();
    const text = (req.text ?? '').trim();
    const html = (req.html ?? '').trim();
    const from = (req.from ?? '').trim() || cfg.fromEmail.default;
    if (!to || !subject || !text) return { sent: false, reason: 'email_invalid', definitiveRejection: true };

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
          ...(req.idempotencyKey ? { 'Idempotency-Key': req.idempotencyKey } : {}),
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          from,
          to: [to],
          subject,
          text,
          ...(html ? { html } : {}),
          ...(req.replyTo?.trim() ? { reply_to: req.replyTo.trim() } : {}),
          ...(req.headers && Object.keys(req.headers).length > 0 ? { headers: req.headers } : {}),
        }),
      });

      if (!res.ok) {
        this.logger.warn(`[resend] send failed status=${res.status}`);
        return { sent: false, reason: 'resend_failed', retryable: res.status === 429 || res.status >= 500, definitiveRejection: [400, 401, 403, 404, 422, 429].includes(res.status) };
      }

      // Drain response; helps debugging if API changes shape later.
      const data = (await res.json().catch(() => null)) as ResendSendEmailResponseOk | null;
      if (!data?.id) {
        // An ambiguous acceptance is retried with the same provider key.
        return { sent: false, reason: 'resend_response_invalid', retryable: true };
      }
      return { sent: true, providerMessageId: data.id };
    } catch (err: unknown) {
      this.logger.warn(`[resend] send failed kind=${err instanceof Error ? err.name : 'unknown'}`);
      return { sent: false, reason: 'email_failed', retryable: true };
    }
  }
}

