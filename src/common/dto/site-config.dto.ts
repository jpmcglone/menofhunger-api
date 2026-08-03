export type SiteConfigAutoVerifyRecruiterDto = {
  id: string;
  username: string | null;
  name: string | null;
  referralCode: string | null;
};

export type SiteConfigDto = {
  id: number;
  postsPerWindow: number;
  windowSeconds: number;
  verifiedPostsPerWindow: number;
  verifiedWindowSeconds: number;
  premiumPostsPerWindow: number;
  premiumWindowSeconds: number;
  autoVerifyNewUsers: boolean;
  autoVerifyRecruiter: SiteConfigAutoVerifyRecruiterDto | null;
};

export type AutoVerifyPreviewUserDto = {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
  recruitedAt: string | null;
};

export type AutoVerifyPreviewDto = {
  recruiter: SiteConfigAutoVerifyRecruiterDto;
  total: number;
  users: AutoVerifyPreviewUserDto[];
};

export type AutoVerifyApplyDto = {
  verifiedCount: number;
  remaining: number;
};
