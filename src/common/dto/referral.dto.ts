export type RecruitDto = {
  // Full user identity fields (mirrors UserListDto so the web can render UserRow)
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: 'none' | 'identity' | 'manual';
  avatarUrl: string | null;
  orgAffiliations: Array<{ id: string; username: string | null; name: string | null; avatarUrl: string | null }>;
  // Referral-specific fields
  recruitedAt: string;
  /** @deprecated use verifiedStatus !== 'none' */
  isVerified: boolean;
  isPremium: boolean;
  bonusGranted: boolean;
};

export type ReferralMeDto = {
  referralCode: string | null;
  recruiter: { username: string | null; name: string | null } | null;
  recruitCount: number;
  referralBonusGranted: boolean;
};

export type AdminReferralInfoDto = {
  referralCode: string | null;
  bonusGrantedAt: string | null;
  recruiter: { id: string; username: string | null; name: string | null } | null;
  recruits: RecruitDto[];
};

export type AdminReferralAnalyticsDto = {
  totalCodesCreated: number;
  totalRecruits: number;
  totalBonusesGranted: number;
  /** Percentage of recruits who have converted to premium (0–100, integer). */
  conversionRatePct: number;
  recruitsOverTime: Array<{ bucket: string; count: number }>;
  topRecruiters: Array<{ userId: string; username: string | null; name: string | null; recruitCount: number }>;
};
