export const NEWSLETTER_STATUSES = ['draft', 'scheduled', 'sending', 'sent'] as const;
export type NewsletterStatusDto = (typeof NEWSLETTER_STATUSES)[number];

export const NEWSLETTER_DURATION_UNITS = ['days', 'weeks', 'months', 'years'] as const;
export type NewsletterDurationUnit = (typeof NEWSLETTER_DURATION_UNITS)[number];

export type NewsletterAudienceFilter =
  | { type: 'inactive'; amount: number; unit: NewsletterDurationUnit }
  | { type: 'joined'; cmp: 'atLeast' | 'inTheLast'; amount: number; unit: NewsletterDurationUnit }
  | { type: 'tier'; min: 'verified' | 'premium' }
  | { type: 'noCheckin'; amount: number; unit: NewsletterDurationUnit };

export type NewsletterAdminDto = {
  id: string;
  status: NewsletterStatusDto;
  subject: string;
  preheader: string;
  bodyJson: string;
  ctaLabel: string | null;
  ctaHref: string | null;
  imageKey: string | null;
  imageUrl: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
  audienceFilters: NewsletterAudienceFilter[];
  /** Members with a confirmed email who are opted into newsletters (no extra filters). */
  confirmedEmailCount: number;
  eligibleCount: number;
  sentCount: number;
  failedCount: number;
};

export type NewsletterAudienceCountDto = {
  confirmedEmailCount: number;
  eligibleCount: number;
};

export type NewsletterPreviewDto = {
  subject: string;
  preheader: string;
  html: string;
  text: string;
};

export type NewsletterUnsubscribeDto = {
  ok: boolean;
};
