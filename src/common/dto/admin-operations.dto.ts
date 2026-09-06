import type { BillingMeDto } from "./billing.dto";

/** Read-only operational diagnostics; provider values are locally recorded state. */
export type AdminMemberDiagnosticsDto = {
  asOf: string;
  member: {
    id: string;
    username: string | null;
    name: string | null;
    createdAt: string;
    verifiedStatus: string;
    bannedAt: string | null;
    lastSeenAt: string | null;
    usernameIsSet: boolean;
    hasBirthdate: boolean;
    menOnlyConfirmed: boolean;
    emailVerified: boolean;
  };
  billing: BillingMeDto;
  providers: {
    stripe: {
      status: string | null;
      periodEnd: string | null;
      cancelAtPeriodEnd: boolean;
      hasSubscription: boolean;
    };
    apple: {
      status: string | null;
      expiresAt: string | null;
      autoRenew: boolean;
      environment: string | null;
      hasPurchase: boolean;
    };
  };
  activity: {
    since: string;
    activeDays: number;
    activeSessions: number;
    openFeedback: number;
  };
  limitations: string[];
};

export type AdminOperationsHealthDto = {
  asOf: string;
  feedback: { new: number; triaged: number };
  pendingReports: number;
  stripeWebhooks: {
    unprocessed: number;
    olderThan15Minutes: number;
    oldestReceivedAt: string | null;
  };
  scheduledPostsWithFailures: number;
  limitations: string[];
};

export type AdminOperationsPostDto = {
  id: string;
  createdAt: string;
  body: string;
  author: { id: string; username: string | null; name: string | null };
  commentCount: number;
  boostCount: number;
};

export type AdminOperationsContentDto = {
  asOf: string;
  since: string;
  before: string;
  posts: AdminOperationsPostDto[];
};
