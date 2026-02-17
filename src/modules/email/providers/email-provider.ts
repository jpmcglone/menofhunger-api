export type EmailSendRequest = {
  to: string;
  subject: string;
  /** Plain text version (required). */
  text: string;
  /** Optional HTML version. */
  html?: string | null;
  /** Optional per-message override (provider-specific requirements may apply). */
  from?: string | null;
};

export type EmailSendResult = { sent: true } | { sent: false; reason: string };

export interface EmailProvider {
  sendEmail(req: EmailSendRequest): Promise<EmailSendResult>;
}

