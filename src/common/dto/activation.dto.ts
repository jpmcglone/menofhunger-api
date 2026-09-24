/** Confirmed, current onboarding progress. Participation uses UTC calendar days. */
export type ActivationDto = {
  phase: 'before_approval' | 'approved';
  verificationRequested: boolean;
  verificationPending: boolean;
  followed: boolean;
  contributed: boolean;
  replied: boolean;
  returned: boolean;
};
