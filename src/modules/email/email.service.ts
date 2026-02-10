import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';

type SendEmailParams = {
  to: string;
  subject: string;
  text: string;
};

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly appConfig: AppConfigService) {}

  async sendText(params: SendEmailParams): Promise<{ sent: boolean; reason?: string }> {
    const cfg = this.appConfig.email();
    if (!cfg) return { sent: false, reason: 'email_not_configured' };

    const to = (params.to ?? '').trim();
    const subject = (params.subject ?? '').trim();
    const text = (params.text ?? '').trim();
    if (!to || !subject || !text) return { sent: false, reason: 'email_invalid' };

    try {
      const url = `https://api.mailgun.net/v3/${encodeURIComponent(cfg.domain)}/messages`;
      const body = new URLSearchParams();
      body.set('from', cfg.fromEmail);
      body.set('to', to);
      body.set('subject', subject);
      body.set('text', text);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${cfg.apiKey}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        this.logger.warn(`[mailgun] send failed: ${res.status} ${msg}`.slice(0, 400));
        return { sent: false, reason: 'mailgun_failed' };
      }
      return { sent: true };
    } catch (err: unknown) {
      this.logger.warn(`[email] send failed: ${(err as Error)?.message ?? String(err)}`);
      return { sent: false, reason: 'email_failed' };
    }
  }
}

