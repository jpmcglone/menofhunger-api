export type EmailSendRequest = {
  to: string;
  /** Stable logical send key used at the provider boundary. */
  idempotencyKey?: string;
  subject: string;
  /** Plain text version (required). */
  text: string;
  /** Optional HTML version. */
  html?: string | null;
  /** Optional per-message override (provider-specific requirements may apply). */
  from?: string | null;
  /** Optional Reply-To (newsletters use the support address). */
  replyTo?: string | null;
  /** Optional provider headers (List-Unsubscribe, etc.). */
  headers?: Record<string, string> | null;
};

export type EmailSendResult = { sent: true; providerMessageId?: string } | { sent: false; reason: string; retryable?: boolean; definitiveRejection?: boolean };

export interface EmailProvider {
  sendEmail(req: EmailSendRequest): Promise<EmailSendResult>;
}

