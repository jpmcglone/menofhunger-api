export type ConversationPersonDto = {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
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
/** UTC calendar days including today. Counts describe activity within this window. */
export type ConversationInsightsDto = {
  from: string;
  to: string;
  postCount: number;
  renewedCount: number;
  participantCount: number;
  newParticipantCount: number;
  timeline: ConversationDayDto[];
  posts: ConversationPostDto[];
};
export type ConversationContextDto = {
  kind: "unanswered" | "newReplies" | "followUp";
  reply: ConversationReplyDto | null;
  relatedPostId: string | null;
};
