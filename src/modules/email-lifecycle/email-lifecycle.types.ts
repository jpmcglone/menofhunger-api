export type LifecycleKind =
  | "verified"
  | "premium"
  | "referralReward"
  | "grantExpiring"
  | "cancellation"
  | "paymentAttention"
  | "accountChanged"
  | "verificationAction"
  | "premiumTip";

/** Immutable facts identify the committed event; the handler reads current permissions/state. */
export type LifecycleEmailEvent = {
  kind: LifecycleKind;
  userId: string;
  eventId: string;
  occurredAt: string;
  source?: "stripe" | "apple" | "grant" | "referral";
  tier?: "premium" | "premiumPlus";
  grantId?: string;
  recruitId?: string;
  /** First-approval orchestration owns the recruit reward in its combined welcome. */
  combinedVerification?: boolean;
  requestId?: string;
  /** Only account security notices may target the previously verified address. */
  previousVerifiedEmail?: string;
  changedField?: "email" | "phone";
};
