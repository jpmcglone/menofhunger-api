/** Confirmed, current onboarding progress. Participation uses UTC calendar days. */
export type ActivationDto = {
  completionSeen: boolean;
  phase: 'before_approval' | 'approved';
  verificationRequested: boolean;
  verificationPending: boolean;
  followed: boolean;
  contributed: boolean;
  replied: boolean;
  returned: boolean;
};

/** Only the first eligible presentation across all devices wins the claim. */
export type ActivationCompletionDto = { present: boolean };
