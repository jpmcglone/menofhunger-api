export type RecruitDto = {
  id: string;
  username: string | null;
  name: string | null;
  avatarKey: string | null;
  recruitedAt: string;
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
