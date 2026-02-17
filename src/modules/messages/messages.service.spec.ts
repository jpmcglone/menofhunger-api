import { MessagesService } from './messages.service';

function makeService(overrides?: {
  prisma?: any;
  appConfig?: any;
  presenceRealtime?: any;
  events?: any;
}) {
  const prisma =
    overrides?.prisma ??
    ({
      userBlock: { findMany: jest.fn(async () => []) },
      messageParticipant: { findMany: jest.fn(async () => []) },
      messageConversation: { findMany: jest.fn(async () => []) },
      message: { count: jest.fn(async () => 0) },
      $queryRaw: jest.fn(async () => []),
    } as any);

  const appConfig = overrides?.appConfig ?? ({ r2: jest.fn(() => null) } as any);
  const presenceRealtime =
    overrides?.presenceRealtime ??
    ({
      emitMessagesUpdated: jest.fn(),
    } as any);
  const events = overrides?.events ?? ({} as any);

  const svc = new MessagesService(prisma, appConfig, presenceRealtime, events);
  return { svc, prisma };
}

describe('MessagesService unread count batching', () => {
  it('getUnreadCounts uses a single batched query and sums by tab', async () => {
    const { svc, prisma } = makeService({
      prisma: {
        userBlock: { findMany: jest.fn(async () => []) },
        messageParticipant: {
          findMany: jest.fn(async () => [
            { conversationId: 'c1', status: 'accepted', lastReadAt: new Date('2026-01-01T00:00:00.000Z') },
            { conversationId: 'c2', status: 'pending', lastReadAt: null },
          ]),
        },
        $queryRaw: jest.fn(async () => [
          { conversationId: 'c1', count: 3 },
          { conversationId: 'c2', count: 7 },
        ]),
      } as any,
    });

    const res = await (svc as any).getUnreadCounts('u1');
    expect(res).toEqual({ primary: 3, requests: 7 });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('listConversations does not call per-conversation message.count', async () => {
    const userId = 'u1';
    const { svc, prisma } = makeService({
      prisma: {
        userBlock: { findMany: jest.fn(async () => []) },
        message: { count: jest.fn(async () => 999) },
        $queryRaw: jest.fn(async () => [
          { conversationId: 'c1', count: 2 },
          { conversationId: 'c2', count: 0 },
        ]),
        messageConversation: {
          findMany: jest.fn(async () => [
            {
              id: 'c1',
              type: 'direct',
              title: null,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              updatedAt: new Date('2026-01-02T00:00:00.000Z'),
              lastMessageAt: new Date('2026-01-02T00:00:00.000Z'),
              lastMessage: { id: 'm1', body: 'hi', createdAt: new Date('2026-01-02T00:00:00.000Z'), senderId: 'u2' },
              participants: [
                {
                  userId,
                  status: 'accepted',
                  role: 'member',
                  acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
                  lastReadAt: new Date('2026-01-01T00:00:00.000Z'),
                  user: {
                    id: userId,
                    username: 'me',
                    name: 'Me',
                    premium: false,
                    premiumPlus: false,
                    isOrganization: false,
                    stewardBadgeEnabled: true,
                    verifiedStatus: 'none',
                    avatarKey: null,
                    avatarUpdatedAt: null,
                  },
                },
                {
                  userId: 'u2',
                  status: 'accepted',
                  role: 'member',
                  acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
                  lastReadAt: new Date('2026-01-01T00:00:00.000Z'),
                  user: {
                    id: 'u2',
                    username: 'other',
                    name: 'Other',
                    premium: false,
                    premiumPlus: false,
                    isOrganization: false,
                    stewardBadgeEnabled: true,
                    verifiedStatus: 'none',
                    avatarKey: null,
                    avatarUpdatedAt: null,
                  },
                },
              ],
            },
            {
              id: 'c2',
              type: 'direct',
              title: null,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              updatedAt: new Date('2026-01-02T00:00:00.000Z'),
              lastMessageAt: null,
              lastMessage: null,
              participants: [
                {
                  userId,
                  status: 'accepted',
                  role: 'member',
                  acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
                  lastReadAt: null,
                  user: {
                    id: userId,
                    username: 'me',
                    name: 'Me',
                    premium: false,
                    premiumPlus: false,
                    isOrganization: false,
                    stewardBadgeEnabled: true,
                    verifiedStatus: 'none',
                    avatarKey: null,
                    avatarUpdatedAt: null,
                  },
                },
              ],
            },
          ]),
        },
      } as any,
    });

    const res = await svc.listConversations({ userId, tab: 'primary', limit: 30, cursor: null });
    expect(res.conversations.map((c) => ({ id: c.id, unreadCount: c.unreadCount }))).toEqual([
      { id: 'c1', unreadCount: 2 },
      { id: 'c2', unreadCount: 0 },
    ]);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.message.count).not.toHaveBeenCalled();
  });
});

