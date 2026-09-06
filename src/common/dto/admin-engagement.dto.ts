export type AdminAttentionItemDto = {
  id: string;
  title: string;
  detail: string;
  count: number;
  path: string;
  priority: 'review' | 'investigate' | 'participate';
};
export type AdminAttentionDto = {
  asOf: string;
  items: AdminAttentionItemDto[];
  unansweredPosts: { id: string; body: string; username: string | null; createdAt: string }[];
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
