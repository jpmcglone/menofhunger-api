import type { ConversationDayDto } from "../../common/dto/conversation.dto";
import { easternDayKey } from "../../common/time/eastern-day-key";
export const DAY_MS = 86_400_000;
export function conversationDays(dayKeys: string[]): ConversationDayDto[] {
  return dayKeys.map((date) => ({
    date,
    replies: 0,
    reposts: 0,
    boosts: 0,
    coins: 0,
    branches: 0,
  }));
}
export function addConversationEvent(
  days: ConversationDayDto[],
  at: Date,
  kind: "replies" | "reposts" | "boosts" | "coins",
  amount = 1,
  branch = false,
) {
  const day = days.find((d) => d.date === easternDayKey(at));
  if (!day) return;
  day[kind] += amount;
  if (branch) day.branches++;
}
/** Relevant, low-exposure questions only; punctuation is a conservative eligibility heuristic. */
export function unansweredOpportunity(
  post: {
    body: string;
    parentId: string | null;
    kind: string;
    commentCount: number;
    viewerCount: number;
    createdAt: Date;
  },
  relevant: boolean,
  seen: boolean,
  now: number,
): boolean {
  return (
    relevant &&
    !seen &&
    !post.parentId &&
    post.kind === "regular" &&
    post.commentCount === 0 &&
    post.viewerCount < 50 &&
    post.body.trim().length >= 30 &&
    /[?？]/u.test(post.body) &&
    now - post.createdAt.getTime() < 48 * 60 * 60 * 1000
  );
}
