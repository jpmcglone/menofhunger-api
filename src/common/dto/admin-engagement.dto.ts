export type AdminAttentionItemDto = {
  id: string;
  title: string;
  detail: string;
  count: number;
  path: string;
  priority: 'review' | 'investigate' | 'participate';
};
export type AdminAttentionPulseDto = {
  windowDays: number;
  since: string;
  before: string;
  memberRoots: number;
  repliedWithin24h: number;
  replyRate24hPct: number | null;
  authors: number;
  authorsReturned: number;
  authorsReturnedPct: number | null;
  lodgePromptReplies: number | null;
  lodgePromptId: string | null;
  verificationPending: number;
  oldestVerificationRequestedAt: string | null;
  definitions: string[];
};
export type AdminAttentionDto = {
  asOf: string;
  items: AdminAttentionItemDto[];
  unansweredPosts: { id: string; body: string; username: string | null; createdAt: string }[];
  pulse: AdminAttentionPulseDto;
};
export type AdminActivationMemberDto = {
  id: string;
  username: string | null;
  createdAt: string;
  verifiedAt: string | null;
  contributedAt: string | null;
  returnedAt: string | null;
  stage: 'joined' | 'verified' | 'contributed' | 'returned';
};
export type AdminActivationDto = {
  asOf: string;
  since: string;
  days: number;
  counts: { joined: number; verified: number; contributed: number; returned: number };
  members: AdminActivationMemberDto[];
  matching: number;
  offset: number;
  limit: number;
  definitions: string[];
};
