import type { AvatarVideoDto } from './avatar-video.dto';
export type RecruitDto = {
  // Full user identity fields (mirrors UserListDto so the web can render UserRow)
  id: string;
  username: string | null;
  name: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: 'none' | 'identity' | 'manual';
  avatarUrl: string | null; avatarVideo?: AvatarVideoDto | null;
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
  /** True when the viewer can claim and share a referral code (verified or premium). */
  canInvite: boolean;
  /** True when the viewer has an active paid subscription (Stripe or Apple IAP). */
  isPayingPremium: boolean;
  /** Total months earned from referral grants (all time). */
  monthsEarned: number;
};

export type AdminReferralInfoDto = {
  referralCode: string | null;
  bonusGrantedAt: string | null;
  recruiter: { id: string; username: string | null; name: string | null } | null;
  recruits: RecruitDto[];
};

export type AdminAcquisitionRowDto = { key: string; signups: number; verified: number };

export type AdminAcquisitionDto = {
  days: number;
  since: string;
  asOf: string;
  totalSignups: number;
  totalVerified: number;
  /** Distinct members who recruited at least one signup in the window. */
  distinctRecruiters: number;
  bySource: AdminAcquisitionRowDto[];
  byCampaign: AdminAcquisitionRowDto[];
};

export type AdminNewMemberPostDto = {
  id: string;
  createdAt: string;
  waitingMinutes: number;
  visibility: string;
  snippet: string;
  author: { id: string; username: string | null; name: string | null; joinedAt: string };
};

export type AdminNewMemberPostsDto = {
  asOf: string;
  newMemberDays: number;
  minAgeMinutes: number;
  count: number;
  posts: AdminNewMemberPostDto[];
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
