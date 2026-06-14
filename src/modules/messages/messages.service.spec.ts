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
  const redis = { getJson: jest.fn(async () => null), setJson: jest.fn(async () => undefined), del: jest.fn(async () => 0) } as any;
  const posthog = { capture: jest.fn() } as any;
  const jobs = { enqueue: jest.fn(async () => ({} as any)) } as any;
  const marvIdentity = {
    cachedMarvUserId: jest.fn(() => null),
    getMarvUserId: jest.fn(async () => null),
  } as any;

  const svc = new MessagesService(prisma, appConfig, presenceRealtime, events, redis, posthog, jobs, marvIdentity);
  return { svc, prisma };
}

describe('MessagesService — Marv group block (env-less identity)', () => {
  it('lookupConversation returns null for a group lookup that includes Marv, even when MARV_USER_ID env is unset', async () => {
    // Reproduces the bug where the env-only `marvCfg.userId` gate silently no-ops:
    // user has Marv as a real bot user in the DB but never pinned `MARV_USER_ID`.
    const { svc } = makeService({
      prisma: {
        userBlock: { findMany: jest.fn(async () => []) },
        messageConversation: { findFirst: jest.fn(), findMany: jest.fn(async () => []) },
      } as any,
      appConfig: {
        // Env says "no MARV_USER_ID configured".
        marvBot: jest.fn(() => ({ enabled: true, userId: null, username: 'marv' })),
        r2: jest.fn(() => null),
      } as any,
    });
    // But the live identity service has resolved Marv via username lookup.
    (svc as unknown as { marvIdentity: { cachedMarvUserId: jest.Mock; getMarvUserId: jest.Mock } }).marvIdentity = {
      cachedMarvUserId: jest.fn(() => 'marv-id-from-cache'),
      getMarvUserId: jest.fn(async () => 'marv-id-from-cache'),
    };

    const result = await (svc as any).lookupConversation({
      userId: 'u1',
      recipientUserIds: ['marv-id-from-cache', 'other-id'],
    });
    expect(result).toEqual({ conversationId: null });
  });

  it('createConversation throws when a group contains Marv resolved via the identity cache', async () => {
    const { svc } = makeService({
      prisma: {
        userBlock: { findMany: jest.fn(async () => []) },
        user: {
          findUnique: jest.fn(async () => ({ premium: true, premiumPlus: false, verifiedStatus: 'manual' })),
          findMany: jest.fn(async () => []),
        },
      } as any,
      appConfig: {
        marvBot: jest.fn(() => ({ enabled: true, userId: null, username: 'marv' })),
        r2: jest.fn(() => null),
      } as any,
    });
    (svc as unknown as { marvIdentity: { cachedMarvUserId: jest.Mock; getMarvUserId: jest.Mock } }).marvIdentity = {
      cachedMarvUserId: jest.fn(() => 'marv-id-from-cache'),
      getMarvUserId: jest.fn(async () => 'marv-id-from-cache'),
    };

    await expect(
      (svc as any).createConversation({
        userId: 'u1',
        recipientUserIds: ['marv-id-from-cache', 'other-id'],
        body: 'hi',
      }),
    ).rejects.toThrow(/group chat/);
  });
});

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

describe('MessagesService – block/unblock emit', () => {
  it('emits users:me-updated with reason block_changed on blockUser', async () => {
    const emitUsersMeRefresh = jest.fn();
    const { svc } = makeService({
      prisma: {
        userBlock: {
          upsert: jest.fn(async () => ({})),
        },
        follow: { deleteMany: jest.fn(async () => ({})) },
      } as any,
      presenceRealtime: {
        emitMessagesUpdated: jest.fn(),
        emitUnreadCounts: jest.fn(),
        emitUsersMeRefresh,
      } as any,
    });

    await svc.blockUser({ userId: 'u1', targetUserId: 'u2' });
    expect(emitUsersMeRefresh).toHaveBeenCalledWith('u1', 'block_changed');
  });

  it('emits users:me-updated with reason block_changed on unblockUser', async () => {
    const emitUsersMeRefresh = jest.fn();
    const { svc } = makeService({
      prisma: {
        userBlock: { deleteMany: jest.fn(async () => ({})) },
      } as any,
      presenceRealtime: {
        emitMessagesUpdated: jest.fn(),
        emitUnreadCounts: jest.fn(),
        emitUsersMeRefresh,
      } as any,
    });

    await svc.unblockUser({ userId: 'u1', targetUserId: 'u2' });
    expect(emitUsersMeRefresh).toHaveBeenCalledWith('u1', 'block_changed');
  });
});

describe('MessagesService.createConversation — mutual-follow DM gate', () => {
  const MUTUAL_FOLLOW_ERROR = 'You can only message people who follow you back. Upgrade to Premium to message any member.';

  function makeForDm(opts: {
    senderPremium: boolean;
    senderFollowingRecipient: boolean;
    senderFollowedByRecipient: boolean;
  }) {
    const sender = {
      premium: opts.senderPremium,
      premiumPlus: false,
      verifiedStatus: 'identity',
      bannedAt: null,
    };
    const recipient = { id: 'u2', verifiedStatus: 'identity', bannedAt: null };

    // follow.findMany is called up to 3 times:
    //   1. senderFollowing: { followerId: 'u1', followingId: { in: ['u2'] } }
    //   2. senderFollowers: { followingId: 'u1', followerId: { in: ['u2'] } }  (in Promise.all with 1)
    //   3. followerSet: { followingId: 'u1', followerId: { in: ['u2'] } }       (premium path only)
    const followFindMany = jest.fn(async (q: any) => {
      if (q.where?.followerId === 'u1') {
        return opts.senderFollowingRecipient ? [{ followingId: 'u2' }] : [];
      }
      if (q.where?.followingId === 'u1') {
        return opts.senderFollowedByRecipient ? [{ followerId: 'u2' }] : [];
      }
      return [];
    });

    const prisma: any = {
      userBlock: { findMany: jest.fn(async () => []) },
      user: {
        findUnique: jest.fn(async () => sender),
        findMany: jest.fn(async () => [recipient]),
      },
      messageConversation: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async () => ({ id: 'conv-1' })),
      },
      messageParticipant: {
        createMany: jest.fn(async () => ({ count: 2 })),
        findMany: jest.fn(async () => [
          { userId: 'u1', role: 'owner', status: 'accepted', acceptedAt: new Date(), lastReadAt: null },
        ]),
      },
      message: {
        create: jest.fn(async () => ({
          id: 'msg-1',
          body: 'hi',
          conversationId: 'conv-1',
          senderId: 'u1',
          createdAt: new Date(),
          media: [],
          sender: {
            id: 'u1', username: 'alice', name: 'Alice', premium: opts.senderPremium, premiumPlus: false,
            isOrganization: false, stewardBadgeEnabled: false, verifiedStatus: 'identity',
            avatarKey: null, avatarUpdatedAt: null,
          },
        })),
        count: jest.fn(async () => 0),
      },
      follow: { findMany: followFindMany },
      $transaction: jest.fn(async (fn: any) => fn({
        messageConversation: { create: jest.fn(async () => ({ id: 'conv-1' })) },
        messageParticipant: { createMany: jest.fn(async () => ({ count: 2 })) },
      })),
    };

    const { svc } = makeService({ prisma });
    return { svc, prisma };
  }

  it('blocks verified non-mutual from starting a DM', async () => {
    const { svc } = makeForDm({ senderPremium: false, senderFollowingRecipient: false, senderFollowedByRecipient: false });
    await expect(
      (svc as any).createConversation({ userId: 'u1', recipientUserIds: ['u2'], body: 'hi' }),
    ).rejects.toThrow(MUTUAL_FOLLOW_ERROR);
  });

  it('blocks verified one-way-follower (sender follows but is not followed back)', async () => {
    const { svc } = makeForDm({ senderPremium: false, senderFollowingRecipient: true, senderFollowedByRecipient: false });
    await expect(
      (svc as any).createConversation({ userId: 'u1', recipientUserIds: ['u2'], body: 'hi' }),
    ).rejects.toThrow(MUTUAL_FOLLOW_ERROR);
  });

  it('allows verified mutual to start a DM (does not throw mutual-follow gate error)', async () => {
    const { svc } = makeForDm({ senderPremium: false, senderFollowingRecipient: true, senderFollowedByRecipient: true });
    await expect(
      (svc as any).createConversation({ userId: 'u1', recipientUserIds: ['u2'], body: 'hi' }),
    ).rejects.not.toThrow(MUTUAL_FOLLOW_ERROR);
  });

  it('allows premium sender to DM a non-mutual verified user (does not throw mutual-follow gate error)', async () => {
    const { svc } = makeForDm({ senderPremium: true, senderFollowingRecipient: false, senderFollowedByRecipient: false });
    await expect(
      (svc as any).createConversation({ userId: 'u1', recipientUserIds: ['u2'], body: 'hi' }),
    ).rejects.not.toThrow(MUTUAL_FOLLOW_ERROR);
  });
});

