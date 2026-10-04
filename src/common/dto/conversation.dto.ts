import type { AvatarVideoDto } from "./avatar-video.dto";
export type ConversationPersonDto = {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  avatarVideo?: AvatarVideoDto | null;
};
export type ConversationReplyDto = {
  id: string;
  body: string;
  createdAt: string;
  author: ConversationPersonDto;
};
export type ConversationDayDto = {
  date: string;
  replies: number;
  reposts: number;
  boosts: number;
  coins: number;
  branches: number;
};
export type ConversationPostDto = {
  id: string;
  body: string;
  createdAt: string;
  renewed: boolean;
  participantCount: number;
  participants: ConversationPersonDto[];
  replies: ConversationReplyDto[];
  timeline: ConversationDayDto[];
};
export type ConversationReachDto = {
  /** Unique people across recap posts, not the sum of per-post unique viewers. */
  people: number;
  /** Sum of the existing lifetime impression counters on recap posts. */
  impressions: number;
  scope: "lifetime";
};
export type ConversationWindowReachDto = {
  people: number;
  impressions: number;
  /** Time bounded tracking began; older impressions cannot be reconstructed. */
  trackedSince: string;
  /** False until the entire requested window has tracked history. */
  complete: boolean;
};
/** Last 7 (weekly recap) or 30 (post) Eastern calendar days including today. Reach is lifetime. */
export type ConversationInsightsDto = {
  from: string;
  to: string;
  postCount: number;
  renewedCount: number;
  participantCount: number;
  newParticipantCount: number;
  reach: ConversationReachDto;
  windowReach?: ConversationWindowReachDto;
  timeline: ConversationDayDto[];
  posts: ConversationPostDto[];
};
export type ConversationContextDto = {
  kind: "unanswered" | "newReplies" | "followUp";
  reply: ConversationReplyDto | null;
  relatedPostId: string | null;
};
