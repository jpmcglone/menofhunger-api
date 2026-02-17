import { Injectable } from '@nestjs/common';
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
  constructor(private readonly resend: ResendEmailProvider) {}

  async sendText(params: SendEmailParams): Promise<{ sent: boolean; reason?: string }> {
    const res = await this.sendEmail({
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
      from: params.from,
    });
    return res.sent ? { sent: true } : { sent: false, reason: res.reason };
  }

  async sendEmail(req: EmailSendRequest): Promise<EmailSendResult> {
    // Provider selection stays centralized here so swapping providers later is trivial.
    // For now, Resend is the only supported provider.
    return await this.resend.sendEmail(req);
  }
}

