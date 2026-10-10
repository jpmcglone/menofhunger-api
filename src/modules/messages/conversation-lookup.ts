import type { PrismaService } from "../prisma/prisma.service";
import type { MessagesSupportService } from "./messages-support.service";

/** Find an existing direct or exact-member group conversation without creating it. */
export async function lookupConversation(
  prisma: PrismaService,
  support: MessagesSupportService,
  params: { userId: string; recipientUserIds: string[] },
) {
  const { userId, recipientUserIds } = params;
  const uniqueRecipients = [
    ...new Set(recipientUserIds.filter(Boolean)),
  ].filter((id) => id !== userId);
  if (uniqueRecipients.length === 0) return { conversationId: null };
  await support.assertNotBlocked(userId, uniqueRecipients);

  // A group with Marv is not allowed; no such conversation can exist.
  if (uniqueRecipients.length > 1) {
    const marvUserId = await support.resolveMarvUserId();
    if (marvUserId && uniqueRecipients.includes(marvUserId)) {
      return { conversationId: null };
    }
  }

  if (uniqueRecipients.length === 1) {
    const directKey = support.directKeyFor(userId, uniqueRecipients[0]);
    const existing = await prisma.messageConversation.findFirst({
      where: { type: "direct", directKey },
      select: { id: true },
    });
    return { conversationId: existing?.id ?? null };
  }

  const memberSet = new Set<string>([userId, ...uniqueRecipients]);
  const candidates = await prisma.messageConversation.findMany({
    where: {
      type: "group",
      participants: {
        some: { userId },
        every: { userId: { in: [...memberSet] } },
      },
    },
    select: {
      id: true,
      participants: { select: { userId: true } },
    },
  });

  for (const convo of candidates) {
    const ids = new Set(convo.participants.map((p) => p.userId));
    if (ids.size !== memberSet.size) continue;
    let match = true;
    for (const id of memberSet) {
      if (!ids.has(id)) {
        match = false;
        break;
      }
    }
    if (match) return { conversationId: convo.id };
  }

  return { conversationId: null };
}
