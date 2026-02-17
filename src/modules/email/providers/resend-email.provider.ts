import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../app/app-config.service';
import type { EmailProvider, EmailSendRequest, EmailSendResult } from './email-provider';

type ResendSendEmailResponseOk = {
  id: string;
};

type ResendSendEmailResponseErr = {
  message?: string;
  name?: string;
  statusCode?: number;
};

@Injectable()
export class ResendEmailProvider implements EmailProvider {
  private readonly logger = new Logger(ResendEmailProvider.name);

  constructor(private readonly appConfig: AppConfigService) {}

  async sendEmail(req: EmailSendRequest): Promise<EmailSendResult> {
    const cfg = this.appConfig.email();
    if (!cfg) return { sent: false, reason: 'email_not_configured' };
    if (cfg.provider !== 'resend') return { sent: false, reason: 'email_provider_not_supported' };

    const to = (req.to ?? '').trim();
    const subject = (req.subject ?? '').trim();
    const text = (req.text ?? '').trim();
    const html = (req.html ?? '').trim();
    const from = (req.from ?? '').trim() || cfg.fromEmail.default;
    if (!to || !subject || !text) return { sent: false, reason: 'email_invalid' };

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject,
          text,
          ...(html ? { html } : {}),
        }),
      });

      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        // Best-effort parse.
        let msg = raw;
        try {
          const parsed = JSON.parse(raw) as ResendSendEmailResponseErr;
          msg = parsed.message || parsed.name || raw;
        } catch {
          // ignore
        }
        this.logger.warn(`[resend] send failed: ${res.status} ${String(msg).slice(0, 300)}`);
        return { sent: false, reason: 'resend_failed' };
      }

      // Drain response; helps debugging if API changes shape later.
      const data = (await res.json().catch(() => null)) as ResendSendEmailResponseOk | null;
      if (!data?.id) {
        // Still treat as success if HTTP 2xx.
        return { sent: true };
      }
      return { sent: true };
    } catch (err: unknown) {
      this.logger.warn(`[resend] send failed: ${(err as Error)?.message ?? String(err)}`);
      return { sent: false, reason: 'email_failed' };
    }
  }
}

