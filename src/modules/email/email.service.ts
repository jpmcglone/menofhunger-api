import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import type { EmailSendRequest, EmailSendResult } from './providers/email-provider';
import { ResendEmailProvider } from './providers/resend-email.provider';

type SendEmailParams = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
};

@Injectable()
export class EmailService {
  constructor(
    private readonly resend: ResendEmailProvider,
    private readonly appConfig: AppConfigService,
  ) {}

  async sendText(params: SendEmailParams): Promise<{ sent: boolean; reason?: string }> {
    const normalized = this.normalizeForDev({
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
      from: params.from,
    });
    const res = await this.sendEmail({
      to: normalized.to,
      subject: normalized.subject,
      text: normalized.text,
      html: normalized.html,
      from: normalized.from,
    });
    return res.sent ? { sent: true } : { sent: false, reason: res.reason };
  }

  async sendEmail(req: EmailSendRequest): Promise<EmailSendResult> {
    const normalized = this.normalizeForDev(req);
    // Provider selection stays centralized here so swapping providers later is trivial.
    // For now, Resend is the only supported provider.
    return await this.resend.sendEmail(normalized);
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

    const bannerHtml =
      '<div style="width:100%;max-width:600px;margin:12px auto 0 auto;padding:8px 12px;border:1px solid #f59e0b;border-radius:10px;background:#fffbeb;color:#92400e;font-size:12px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;text-align:center;">Dev - Men of Hunger</div>';
    const htmlWithBanner = html.replace(/(<body\b[^>]*>)/i, `$1${bannerHtml}`);

    return { ...req, subject: prefixedSubject, text: prefixedText, html: htmlWithBanner };
  }
}

