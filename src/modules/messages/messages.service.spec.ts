import { MessagesService, messageMediaCreateData } from './messages.service';
import { MessagesController } from './messages.controller';
import { VerifiedGuard } from '../auth/verified.guard';

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

  const sideEffects = { dispatch: jest.fn() } as any;
  const callSessions = {
    getByConversationId: jest.fn(async () => null),
    getManyByConversationIds: jest.fn(async () => new Map()),
  } as any;
  const svc = new MessagesService(prisma, appConfig, presenceRealtime, events, redis, posthog, jobs, marvIdentity, sideEffects, callSessions);
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
            isOrganization: false, verifiedStatus: 'identity',
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
describe('MessagesService.createConversation — admin bypass', () => {
  function makeForAdminDm(opts: {
    senderIsAdmin: boolean;
    senderVerified?: boolean;
    senderPremium?: boolean;
    recipientUnverified?: boolean;
    recipientBanned?: boolean;
  }) {
    const sender = {
      premium: opts.senderPremium ?? false,
      premiumPlus: false,
      verifiedStatus: (opts.senderVerified ?? false) ? 'identity' : 'none',
      bannedAt: null,
      siteAdmin: opts.senderIsAdmin,
    };
    const recipient = {
      id: 'u2',
      verifiedStatus: opts.recipientUnverified ? 'none' : 'identity',
      bannedAt: opts.recipientBanned ? new Date() : null,
    };

    const capturedCreateMany: { data: any[] | null } = { data: null };
    const now = new Date();
    const prisma: any = {
      userBlock: { findMany: jest.fn(async () => []) },
      user: {
        findUnique: jest.fn(async () => sender),
        findMany: jest.fn(async () => [recipient]),
      },
      messageConversation: { findFirst: jest.fn(async () => null) },
      follow: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn(async (fn: any) =>
        fn({
          messageConversation: {
            create: jest.fn(async () => ({ id: 'conv-1' })),
            update: jest.fn(async () => ({})),
          },
          messageParticipant: {
            createMany: jest.fn(async (args: any) => {
              capturedCreateMany.data = args.data;
              return { count: args.data.length };
            }),
          },
          message: {
            create: jest.fn(async () => ({
              id: 'msg-1',
              body: 'hi',
              conversationId: 'conv-1',
              senderId: 'u1',
              replyTo: null,
              createdAt: now,
              media: [],
              sender: {
                id: 'u1', username: 'admin', name: 'Admin', premium: false, premiumPlus: false,
                isOrganization: false, verifiedStatus: 'none',
                avatarKey: null, avatarUpdatedAt: null,
              },
            })),
          },
        }),
      ),
    };

    const presenceRealtime: any = { emitMessageCreated: jest.fn(), emitUnreadCounts: jest.fn() };
    const events: any = { emitMessagePushRequested: jest.fn() };

    const { svc } = makeService({ prisma, presenceRealtime, events });
    return { svc, capturedCreateMany };
  }

  it('admin can open a thread with an unverified recipient', async () => {
    const { svc } = makeForAdminDm({ senderIsAdmin: true, recipientUnverified: true });
    await expect(
      (svc as any).createConversation({ userId: 'u1', recipientUserIds: ['u2'], body: 'hi' }),
    ).resolves.toMatchObject({ conversationId: 'conv-1' });
  });

  it('admin-created recipient row has status accepted and a non-null acceptedAt', async () => {
    const { svc, capturedCreateMany } = makeForAdminDm({ senderIsAdmin: true, recipientUnverified: true });
    await (svc as any).createConversation({ userId: 'u1', recipientUserIds: ['u2'], body: 'hi' });
    const recipientRow = capturedCreateMany.data?.find((r: any) => r.userId === 'u2');
    expect(recipientRow?.status).toBe('accepted');
    expect(recipientRow?.acceptedAt).not.toBeNull();
  });

  it('unverified non-admin sender cannot start a new conversation', async () => {
    const { svc } = makeForAdminDm({ senderIsAdmin: false, senderVerified: false, senderPremium: false });
    await expect(
      (svc as any).createConversation({ userId: 'u1', recipientUserIds: ['u2'], body: 'hi' }),
    ).rejects.toThrow('Verify to use chat.');
  });

  it('verified non-admin cannot message an unverified recipient', async () => {
    const { svc } = makeForAdminDm({ senderIsAdmin: false, senderVerified: true, recipientUnverified: true });
    await expect(
      (svc as any).createConversation({ userId: 'u1', recipientUserIds: ['u2'], body: 'hi' }),
    ).rejects.toThrow('You can only start chats with verified members.');
  });

  it('admin still cannot message a banned user', async () => {
    const { svc } = makeForAdminDm({ senderIsAdmin: true, recipientBanned: true });
    await expect(
      (svc as any).createConversation({ userId: 'u1', recipientUserIds: ['u2'], body: 'hi' }),
    ).rejects.toThrow('Cannot message a banned user.');
  });
});

describe('messageMediaCreateData', () => {
  it('maps upload video fields for nested create so send DTOs include media', () => {
    expect(
      messageMediaCreateData([
        {
          source: 'upload',
          kind: 'video',
          r2Key: 'uploads/u1/videos/a.mp4',
          thumbnailR2Key: 'uploads/u1/thumbnails/a.jpg',
          width: 1920,
          height: 1080,
          durationSeconds: 4,
          alt: null,
        },
      ]),
    ).toEqual([
      {
        source: 'upload',
        kind: 'video',
        r2Key: 'uploads/u1/videos/a.mp4',
        thumbnailR2Key: 'uploads/u1/thumbnails/a.jpg',
        width: 1920,
        height: 1080,
        durationSeconds: 4,
        alt: null,
      },
    ]);
  });
});

describe('MessagesService.attachCallVoicemail', () => {
  const video = {
    source: 'upload' as const,
    kind: 'video' as const,
    r2Key: 'uploads/alice/voicemail/a.mp4',
    thumbnailR2Key: 'uploads/alice/thumbnails/a.jpg',
    width: 720,
    height: 1280,
    durationSeconds: 8,
    alt: null,
  };

  function makeVoicemailService(message: any, extras?: { events?: any; presenceRealtime?: any }) {
    const presenceRealtime = extras?.presenceRealtime ?? { emitMessageEdited: jest.fn() };
    const events = extras?.events ?? { emitMessagePushRequested: jest.fn() };
    const conversation = {
      id: 'c1',
      type: 'direct',
      participants: [
        { userId: 'alice', status: 'accepted' },
        { userId: 'bob', status: 'accepted' },
      ],
    };
    const updated = {
      id: message.id,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      body: 'Missed video call · Left a message',
      conversationId: 'c1',
      senderId: 'alice',
      kind: 'call',
      callMeta: message.callMeta,
      deletedForAll: false,
      editedAt: null,
      replyTo: null,
      deletions: [],
      reactions: [],
      media: [{
        id: 'mm1',
        kind: 'video',
        source: 'upload',
        r2Key: video.r2Key,
        thumbnailR2Key: video.thumbnailR2Key,
        url: null,
        mp4Url: null,
        width: 720,
        height: 1280,
        durationSeconds: 8,
        alt: null,
      }],
      sender: {
        id: 'alice',
        username: 'alice',
        name: 'Alice',
        premium: false,
        premiumPlus: false,
        isOrganization: false,
        verifiedStatus: 'manual',
        avatarKey: null,
        avatarUpdatedAt: null,
        isBot: false,
      },
    };
    const prisma = {
      userBlock: { findMany: jest.fn(async () => []) },
      messageConversation: { findFirst: jest.fn(async () => conversation) },
      message: {
        findFirst: jest.fn(async () => message),
        update: jest.fn(async () => updated),
      },
      messageMedia: { create: jest.fn(async () => ({ id: 'mm1' })) },
      $transaction: jest.fn(async (fn: any) => fn({
        messageMedia: { create: jest.fn(async () => ({ id: 'mm1' })) },
        message: { update: jest.fn(async () => updated) },
      })),
    };
    return makeService({ prisma, presenceRealtime, events });
  }

  const missedCall = {
    id: 'm1',
    conversationId: 'c1',
    senderId: 'alice',
    kind: 'call',
    callMeta: { callId: 'call1', type: 'video', outcome: 'missed', durationSeconds: null, peakParticipantCount: 1 },
    media: [],
  };

  it('attaches video to a missed call the viewer started', async () => {
    const { svc, prisma } = makeVoicemailService(missedCall);
    const dto = await svc.attachCallVoicemail({
      userId: 'alice',
      conversationId: 'c1',
      messageId: 'm1',
      media: video,
    });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(dto.body).toBe('Missed video call · Left a message');
  });

  it('rejects a call that was not missed', async () => {
    const { svc } = makeVoicemailService({
      ...missedCall,
      callMeta: { ...missedCall.callMeta, outcome: 'ended' },
    });
    await expect(
      svc.attachCallVoicemail({ userId: 'alice', conversationId: 'c1', messageId: 'm1', media: video }),
    ).rejects.toThrow('missed call');
  });

  it('rejects a non-caller', async () => {
    const { svc } = makeVoicemailService(missedCall);
    await expect(
      svc.attachCallVoicemail({ userId: 'bob', conversationId: 'c1', messageId: 'm1', media: video }),
    ).rejects.toThrow('Only the caller');
  });

  it('rejects a second attach', async () => {
    const { svc } = makeVoicemailService({ ...missedCall, media: [{ id: 'already' }] });
    await expect(
      svc.attachCallVoicemail({ userId: 'alice', conversationId: 'c1', messageId: 'm1', media: video }),
    ).rejects.toThrow('already has a video message');
  });
});

describe('MessagesService — delete conversation then talk again', () => {
  const restoredConversation = {
    id: 'c1',
    type: 'direct',
    directKey: 'u1:u2',
    createdByUserId: 'u1',
    title: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastMessageAt: null,
    lastMessageId: null,
    lastMessage: null,
    crewWall: null,
    participants: [
      { userId: 'u1', status: 'accepted', role: 'owner', acceptedAt: new Date(), lastReadAt: new Date(), mutedAt: null, user: { id: 'u1' } },
      { userId: 'u2', status: 'accepted', role: 'member', acceptedAt: new Date(), lastReadAt: new Date(), mutedAt: null, user: { id: 'u2' } },
    ],
  };

  it('getConversation restores a viewer who left a direct thread', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(restoredConversation);
    const createMany = jest.fn(async () => ({ count: 1 }));
    const { svc, prisma } = makeService({
      prisma: {
        userBlock: { findMany: jest.fn(async () => []) },
        messageConversation: {
          findFirst,
          findUnique: jest.fn(async () => ({
            type: 'direct',
            directKey: 'u1:u2',
            createdByUserId: 'u1',
          })),
        },
        messageParticipant: {
          findMany: jest.fn(async () => [{ userId: 'u2' }]),
          createMany,
        },
        message: { count: jest.fn(async () => 0), findMany: jest.fn(async () => []) },
      } as any,
    });

    const result = await (svc as any).getConversationOrThrow({ userId: 'u1', conversationId: 'c1' });
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            conversationId: 'c1',
            userId: 'u1',
            role: 'owner',
            status: 'accepted',
          }),
        ],
      }),
    );
    expect(result.id).toBe('c1');
    expect(prisma.messageConversation.findFirst).toHaveBeenCalledTimes(2);
  });

  it('getConversation does not restore a blocked pair', async () => {
    const createMany = jest.fn(async () => ({ count: 1 }));
    const { svc } = makeService({
      prisma: {
        userBlock: {
          findMany: jest.fn(async () => [{ blockerId: 'u1', blockedId: 'u2' }]),
        },
        messageConversation: {
          findFirst: jest.fn(async () => null),
          findUnique: jest.fn(async () => ({
            type: 'direct',
            directKey: 'u1:u2',
            createdByUserId: 'u1',
          })),
        },
        messageParticipant: { findMany: jest.fn(async () => []), createMany },
      } as any,
    });

    await expect((svc as any).getConversationOrThrow({ userId: 'u1', conversationId: 'c1' })).rejects.toThrow(
      'Conversation not found.',
    );
    expect(createMany).not.toHaveBeenCalled();
  });

  it('getConversation does not restore a group the viewer left', async () => {
    const createMany = jest.fn(async () => ({ count: 1 }));
    const { svc } = makeService({
      prisma: {
        userBlock: { findMany: jest.fn(async () => []) },
        messageConversation: {
          findFirst: jest.fn(async () => null),
          findUnique: jest.fn(async () => ({
            type: 'group',
            directKey: null,
            createdByUserId: 'u1',
          })),
        },
        messageParticipant: { findMany: jest.fn(async () => []), createMany },
      } as any,
    });

    await expect((svc as any).getConversationOrThrow({ userId: 'u1', conversationId: 'g1' })).rejects.toThrow(
      'Conversation not found.',
    );
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe('MessagesController — VerifiedGuard invariant', () => {
  it('MessagesController does NOT carry VerifiedGuard (unverified users must be able to read/reply in admin-initiated threads)', () => {
    const classGuards = (Reflect.getMetadata('__guards__', MessagesController) as unknown[] | undefined) ?? [];
    expect(classGuards).not.toContain(VerifiedGuard);
  });
});
