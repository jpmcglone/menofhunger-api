import { Prisma } from '@prisma/client';
import { MarvinPrivateCannedRepliesService } from './marvin-private-canned-replies.service';

type Reason = 'not_premium' | 'ai_not_configured';

function makeService() {
  const claimed = new Set<string>();
  const key = (userId: string, conversationId: string, reason: Reason) =>
    `${userId}|${conversationId}|${reason}`;
  const prisma: any = {
    marvinPrivateCannedReply: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = key(
          where.userId_conversationId_reason.userId,
          where.userId_conversationId_reason.conversationId,
          where.userId_conversationId_reason.reason,
        );
        return claimed.has(k) ? { id: 'row-1' } : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const k = key(data.userId, data.conversationId, data.reason);
        if (claimed.has(k)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        claimed.add(k);
        return { id: 'row-' + claimed.size };
      }),
      update: jest.fn(async () => ({})),
    },
  };
  const svc = new MarvinPrivateCannedRepliesService(prisma);
  return { svc, prisma };
}

describe('MarvinPrivateCannedRepliesService', () => {
  it('claims (user, conversation, reason) once', async () => {
    const { svc } = makeService();
    expect(
      await svc.tryClaim({
        userId: 'u1',
        conversationId: 'c1',
        reason: 'ai_not_configured',
      }),
    ).toBe(true);
    expect(
      await svc.tryClaim({
        userId: 'u1',
        conversationId: 'c1',
        reason: 'ai_not_configured',
      }),
    ).toBe(false);
  });

  it('treats reasons as independent slots within a conversation', async () => {
    const { svc } = makeService();
    expect(
      await svc.tryClaim({
        userId: 'u1',
        conversationId: 'c1',
        reason: 'not_premium',
      }),
    ).toBe(true);
    expect(
      await svc.tryClaim({
        userId: 'u1',
        conversationId: 'c1',
        reason: 'ai_not_configured',
      }),
    ).toBe(true);
  });

  it('hasAlreadyReplied flips after a successful claim', async () => {
    const { svc } = makeService();
    expect(
      await svc.hasAlreadyReplied({
        userId: 'u1',
        conversationId: 'c1',
        reason: 'ai_not_configured',
      }),
    ).toBe(false);
    await svc.tryClaim({ userId: 'u1', conversationId: 'c1', reason: 'ai_not_configured' });
    expect(
      await svc.hasAlreadyReplied({
        userId: 'u1',
        conversationId: 'c1',
        reason: 'ai_not_configured',
      }),
    ).toBe(true);
  });

  it('setMarvinMessageId swallows update failures', async () => {
    const { svc, prisma } = makeService();
    prisma.marvinPrivateCannedReply.update.mockRejectedValueOnce(new Error('boom'));
    await expect(
      svc.setMarvinMessageId({
        userId: 'u1',
        conversationId: 'c1',
        reason: 'ai_not_configured',
        marvinMessageId: 'm1',
      }),
    ).resolves.toBeUndefined();
  });
});
