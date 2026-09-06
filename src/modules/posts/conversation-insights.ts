import type { ConversationDayDto } from "../../common/dto/conversation.dto";
export const DAY_MS = 86_400_000;
export function conversationDays(from: Date, to: Date): ConversationDayDto[] {
  const days: ConversationDayDto[] = [];
  for (let at = from.getTime(); at < to.getTime(); at += DAY_MS) {
    days.push({
      date: new Date(at).toISOString().slice(0, 10),
      replies: 0,
      reposts: 0,
      coins: 0,
      branches: 0,
    });
  }
  return days;
}
export function addConversationEvent(
  days: ConversationDayDto[],
  at: Date,
  kind: "replies" | "reposts" | "coins",
  amount = 1,
  branch = false,
) {
  const day = days.find((d) => d.date === at.toISOString().slice(0, 10));
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
