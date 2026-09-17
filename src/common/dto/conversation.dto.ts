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
  /** Unique known viewers across recap posts; anonymous browsers are estimates. */
  people: number;
  /** Sum of the existing lifetime impression counters on recap posts. */
  impressions: number;
  scope: "lifetime";
};
/** UTC calendar days including today. Activity uses this window; reach is lifetime. */
export type ConversationInsightsDto = {
  from: string;
  to: string;
  postCount: number;
  renewedCount: number;
  participantCount: number;
  newParticipantCount: number;
  reach: ConversationReachDto;
  timeline: ConversationDayDto[];
  posts: ConversationPostDto[];
};
export type ConversationContextDto = {
  kind: "unanswered" | "newReplies" | "followUp";
  reply: ConversationReplyDto | null;
  relatedPostId: string | null;
};
