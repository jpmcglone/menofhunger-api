/**
 * Unit tests for the extracted gateway handler modules, using the FakeSocket /
 * FakeServer pattern (no real Socket.IO process or Redis).
 */

import { GatewayContextService } from './gateway-context.service';
import { GatewayThrottleService } from './gateway-throttle.service';
import { RadioGatewayHandler } from './gateway-radio.handler';
import { ContentSubscriptionsHandler } from './gateway-subscriptions.handler';
import { MessagingGatewayHandler } from './gateway-messaging.handler';
import { PresenceStatusHandler } from './gateway-presence.handler';
import { CommunityGroupReadAccessService } from '../../viewer/community-group-read-access.service';

// ─── Lightweight fake socket.io infrastructure ──────────────────────────────

type EmittedEvent = { event: string; payload: unknown };

class FakeSocket {
  readonly id: string;
  readonly emitted: EmittedEvent[] = [];
  readonly data: Record<string, unknown> = {};
  readonly joined = new Set<string>();

  constructor(id: string, data: Record<string, unknown> = {}) {
    this.id = id;
    Object.assign(this.data, data);
  }

  emit(event: string, payload?: unknown): this {
    this.emitted.push({ event, payload: payload ?? null });
    return this;
  }

  join(room: string) { this.joined.add(room); }
  leave(room: string) { this.joined.delete(room); }
  to(_room: string): this { return this; }
  lastEmitted(event: string): unknown {
    const all = this.emitted.filter((e) => e.event === event);
    return all[all.length - 1]?.payload ?? undefined;
  }
  allEmitted(event: string): unknown[] {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload);
  }
}

class FakeServer {
  readonly socketsById = new Map<string, FakeSocket>();
  private readonly rooms = new Map<string, Set<string>>();
  readonly emitted: EmittedEvent[] = [];

  register(socket: FakeSocket) {
    this.socketsById.set(socket.id, socket);
  }

  joinRoom(socketId: string, room: string) {
    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    this.rooms.get(room)!.add(socketId);
  }

  asIoServer(): any {
    return {
      sockets: { sockets: this.socketsById },
      to: (room: string) => ({
        emit: (event: string, payload?: unknown) => {
          this.emitted.push({ event, payload: payload ?? null });
          for (const id of this.rooms.get(room) ?? []) {
            this.socketsById.get(id)?.emit(event, payload);
          }
        },
      }),
      emit: (event: string, payload?: unknown) => this.emitted.push({ event, payload: payload ?? null }),
    };
  }
}

function makeContext(presence: any, server: FakeServer): GatewayContextService {
  const ctx = new GatewayContextService({ isProd: jest.fn().mockReturnValue(true) } as any, presence);
  ctx.setServer(server.asIoServer());
  return ctx;
}

function makePresence(overrides: Record<string, unknown> = {}) {
  return {
    getUserIdForSocket: jest.fn().mockReturnValue(null),
    getSocketIdsForUser: jest.fn().mockReturnValue([]),
    getSubscribers: jest.fn().mockReturnValue(new Set<string>()),
    getOnlineFeedListeners: jest.fn().mockReturnValue(new Set<string>()),
    getChatScreenSocketIdsForUser: jest.fn().mockReturnValue([]),
    setChatScreenActive: jest.fn(),
    setActiveConversation: jest.fn(),
    ...overrides,
  } as any;
}

function makePresenceRedis() {
  return {
    publishEmitToRoom: jest.fn().mockResolvedValue(undefined),
    publishUserSpaceChanged: jest.fn().mockResolvedValue(undefined),
    publishSpacesLobbyCounts: jest.fn().mockResolvedValue(undefined),
  } as any;
}

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── GatewayThrottleService ──────────────────────────────────────────────────

describe('GatewayThrottleService', () => {
  it('allows the first emit and throttles repeats within the interval', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    const throttle = new GatewayThrottleService();
    expect(throttle.shouldEmitTyping('k', 700)).toBe(true);
    expect(throttle.shouldEmitTyping('k', 700)).toBe(false);
    (Date.now as jest.Mock).mockReturnValue(1800);
    expect(throttle.shouldEmitTyping('k', 700)).toBe(true);
  });

  it('tracks reaction throttles independently of typing throttles', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    const throttle = new GatewayThrottleService();
    expect(throttle.shouldEmitReaction('k', 400)).toBe(true);
    // Same key, different map — typing is unaffected.
    expect(throttle.shouldEmitTyping('k', 700)).toBe(true);
    expect(throttle.shouldEmitReaction('k', 400)).toBe(false);
  });

  it('clearTypingThrottleForUser drops the user-prefixed keys', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    const throttle = new GatewayThrottleService();
    throttle.shouldEmitTyping('u1:conv:1', 700);
    throttle.shouldEmitTyping('spaces:u1:space:1', 250);
    throttle.shouldEmitTyping('u2:conv:1', 700);

    throttle.clearTypingThrottleForUser('u1');

    expect(throttle.shouldEmitTyping('u1:conv:1', 700)).toBe(true);
    expect(throttle.shouldEmitTyping('spaces:u1:space:1', 250)).toBe(true);
    expect(throttle.shouldEmitTyping('u2:conv:1', 700)).toBe(false);
  });
});

// ─── RadioGatewayHandler ─────────────────────────────────────────────────────

describe('RadioGatewayHandler', () => {
  function makeRadioFixture() {
    const server = new FakeServer();
    const presence = makePresence({ getSocketIdsForUser: jest.fn().mockReturnValue([]) });
    const presenceRedis = makePresenceRedis();
    const radio = {
      isValidStationId: jest.fn().mockReturnValue(true),
      join: jest.fn().mockReturnValue({ prevStationId: null, prevRoomStationId: null }),
      getListenersForStation: jest.fn().mockReturnValue({ userIds: [], pausedUserIds: [], mutedUserIds: [] }),
      getLobbyCountsByStationId: jest.fn().mockReturnValue({ 'station-1': 1 }),
      onDisconnect: jest.fn().mockReturnValue(null),
    } as any;
    const follows = { getFollowListUsersByIds: jest.fn().mockResolvedValue([]) } as any;
    const handler = new RadioGatewayHandler(presence, presenceRedis, follows, radio, {} as any, makeContext(presence, server));
    return { server, presence, radio, handler };
  }

  it('radio:join joins the station room and emits listeners + lobby counts', async () => {
    const { server, handler, radio } = makeRadioFixture();
    const socket = new FakeSocket('s1', { userId: 'u1' });
    server.register(socket);
    server.joinRoom('s1', 'radio:station-1');

    await handler.handleRadioJoin(socket as any, { stationId: 'station-1' });

    expect(radio.join).toHaveBeenCalledWith({ socketId: 's1', userId: 'u1', stationId: 'station-1' });
    expect(socket.joined.has('radio:station-1')).toBe(true);
    expect(socket.lastEmitted('radio:listeners')).toEqual({ stationId: 'station-1', listeners: [] });
  });

  it('radio:join notifies the user\'s other sockets with radio:replaced', async () => {
    const { server, presence, handler } = makeRadioFixture();
    const socket = new FakeSocket('s1', { userId: 'u1' });
    const otherTab = new FakeSocket('s2', { userId: 'u1' });
    server.register(socket);
    server.register(otherTab);
    presence.getSocketIdsForUser.mockReturnValue(['s1', 's2']);

    await handler.handleRadioJoin(socket as any, { stationId: 'station-1' });

    expect(otherTab.allEmitted('radio:replaced')).toHaveLength(1);
    expect(socket.allEmitted('radio:replaced')).toHaveLength(0);
  });

  it('disconnect cleanup emits listeners for the left station when active', () => {
    const { server, handler, radio } = makeRadioFixture();
    const socket = new FakeSocket('s1', { userId: 'u1' });
    server.register(socket);
    radio.onDisconnect.mockReturnValueOnce({ stationId: 'station-1', wasActive: true });

    handler.handleDisconnect(socket as any);

    expect(radio.onDisconnect).toHaveBeenCalledWith('s1');
    // Lobby counts go to the radio:lobbies room via the server.
    expect(server.emitted.some((e) => e.event === 'radio:lobbyCounts')).toBe(true);
  });
});

// ─── ContentSubscriptionsHandler ─────────────────────────────────────────────

describe('ContentSubscriptionsHandler', () => {
  function makeSubsFixture(opts: {
    posts?: Array<{ id: string; userId: string; visibility: string; communityGroupId?: string | null }>;
    articles?: Array<{ id: string; authorId: string; visibility: string }>;
    groupPolicies?: Array<{ id: string; joinPolicy: 'open' | 'approval' }>;
    memberships?: Array<{ groupId: string }>;
  } = {}) {
    const prisma = {
      post: { findMany: jest.fn().mockResolvedValue(opts.posts ?? []) },
      article: { findMany: jest.fn().mockResolvedValue(opts.articles ?? []) },
      communityGroup: { findMany: jest.fn().mockResolvedValue(opts.groupPolicies ?? []) },
      communityGroupMember: { findMany: jest.fn().mockResolvedValue(opts.memberships ?? []) },
    } as any;
    const groupReadAccess = new CommunityGroupReadAccessService(prisma, {} as any);
    return { handler: new ContentSubscriptionsHandler(prisma, groupReadAccess), prisma };
  }

  it('accepts a public post and joins its room', async () => {
    const { handler } = makeSubsFixture({ posts: [{ id: 'p1', userId: 'author', visibility: 'public', communityGroupId: null }] });
    const socket = new FakeSocket('s1', { userId: 'viewer', viewer: {} });

    await handler.handlePostsSubscribe(socket as any, { postIds: ['p1'] });

    expect(socket.joined.has('post:p1')).toBe(true);
    expect(socket.lastEmitted('posts:subscribed')).toEqual({ postIds: ['p1'] });
  });

  it('rejects a verifiedOnly post for an unverified viewer but accepts it for the author', async () => {
    const posts = [{ id: 'p1', userId: 'author', visibility: 'verifiedOnly', communityGroupId: null }];

    const { handler } = makeSubsFixture({ posts });
    const viewerSocket = new FakeSocket('s1', { userId: 'viewer', viewer: { verified: false } });
    await handler.handlePostsSubscribe(viewerSocket as any, { postIds: ['p1'] });
    expect(viewerSocket.allEmitted('posts:subscribed')).toHaveLength(0);

    const { handler: handler2 } = makeSubsFixture({ posts });
    const authorSocket = new FakeSocket('s2', { userId: 'author', viewer: { verified: false } });
    await handler2.handlePostsSubscribe(authorSocket as any, { postIds: ['p1'] });
    expect(authorSocket.lastEmitted('posts:subscribed')).toEqual({ postIds: ['p1'] });
  });

  it('gates group posts on group read access', async () => {
    const { handler } = makeSubsFixture({
      posts: [{ id: 'p1', userId: 'author', visibility: 'public', communityGroupId: 'g1' }],
      groupPolicies: [{ id: 'g1', joinPolicy: 'approval' }],
      memberships: [],
    });
    const socket = new FakeSocket('s1', { userId: 'viewer', viewer: { verified: true } });

    await handler.handlePostsSubscribe(socket as any, { postIds: ['p1'] });

    expect(socket.allEmitted('posts:subscribed')).toHaveLength(0);
    expect(socket.joined.has('post:p1')).toBe(false);
  });

  it('posts:unsubscribe leaves the room and clears the sub', async () => {
    const { handler } = makeSubsFixture({ posts: [{ id: 'p1', userId: 'a', visibility: 'public', communityGroupId: null }] });
    const socket = new FakeSocket('s1', { userId: 'viewer', viewer: {} });
    await handler.handlePostsSubscribe(socket as any, { postIds: ['p1'] });

    handler.handlePostsUnsubscribe(socket as any, { postIds: ['p1'] });

    expect(socket.joined.has('post:p1')).toBe(false);
    expect(((socket.data as any).postSubs as Set<string>).has('p1')).toBe(false);
  });

  it('rejects a premiumOnly article for a free viewer', async () => {
    const { handler } = makeSubsFixture({ articles: [{ id: 'a1', authorId: 'author', visibility: 'premiumOnly' }] });
    const socket = new FakeSocket('s1', { userId: 'viewer', viewer: { verified: true, premium: false } });

    await handler.handleArticlesSubscribe(socket as any, { articleIds: ['a1'] });

    expect(socket.allEmitted('articles:subscribed')).toHaveLength(0);
  });

  it('accepts an article for a premium viewer', async () => {
    const { handler } = makeSubsFixture({ articles: [{ id: 'a1', authorId: 'author', visibility: 'premiumOnly' }] });
    const socket = new FakeSocket('s1', { userId: 'viewer', viewer: { premium: true } });

    await handler.handleArticlesSubscribe(socket as any, { articleIds: ['a1'] });

    expect(socket.lastEmitted('articles:subscribed')).toEqual({ articleIds: ['a1'] });
    expect(socket.joined.has('article:a1')).toBe(true);
  });
});

// ─── MessagingGatewayHandler ─────────────────────────────────────────────────

describe('MessagingGatewayHandler', () => {
  function makeMessagingFixture() {
    const server = new FakeServer();
    const presence = makePresence();
    const presenceRedis = makePresenceRedis();
    const messages = { listConversationParticipantUserIds: jest.fn().mockResolvedValue([]) } as any;
    const throttle = new GatewayThrottleService();
    const handler = new MessagingGatewayHandler(presence, presenceRedis, messages, throttle, makeContext(presence, server));
    return { server, presence, messages, handler };
  }

  it('messages:screen records chat-screen + active conversation state', () => {
    const { presence, handler } = makeMessagingFixture();
    presence.getUserIdForSocket.mockReturnValue('u1');
    const socket = new FakeSocket('s1');

    handler.handleMessagesScreen(socket as any, { active: true, conversationId: 'c1' });

    expect(presence.setChatScreenActive).toHaveBeenCalledWith('s1', true);
    expect(presence.setActiveConversation).toHaveBeenCalledWith('s1', 'c1');
  });

  it('messages:typing fans out to the other participants\' chat-screen sockets only', async () => {
    const { server, presence, messages, handler } = makeMessagingFixture();
    presence.getUserIdForSocket.mockReturnValue('u1');
    messages.listConversationParticipantUserIds.mockResolvedValue(['u1', 'u2']);
    const target = new FakeSocket('s-target');
    server.register(target);
    presence.getChatScreenSocketIdsForUser.mockImplementation((id: string) => (id === 'u2' ? ['s-target'] : []));

    await handler.handleMessagesTyping(new FakeSocket('s1') as any, { conversationId: 'c1', typing: true });

    expect(target.lastEmitted('messages:typing')).toEqual({ conversationId: 'c1', userId: 'u1', typing: true });
  });

  it('messages:typing is throttled per user+conversation+direction', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    const { presence, messages, handler } = makeMessagingFixture();
    presence.getUserIdForSocket.mockReturnValue('u1');
    messages.listConversationParticipantUserIds.mockResolvedValue(['u1', 'u2']);
    const socket = new FakeSocket('s1');

    await handler.handleMessagesTyping(socket as any, { conversationId: 'c1', typing: true });
    await handler.handleMessagesTyping(socket as any, { conversationId: 'c1', typing: true });

    expect(messages.listConversationParticipantUserIds).toHaveBeenCalledTimes(1);
  });
});

// ─── PresenceStatusHandler ───────────────────────────────────────────────────

describe('PresenceStatusHandler', () => {
  function makePresenceHandlerFixture() {
    const server = new FakeServer();
    const presence = makePresence({
      setUserIdle: jest.fn(),
      setUserActive: jest.fn(),
      setLastActivity: jest.fn(),
      isUserIdle: jest.fn().mockReturnValue(false),
      persistLastSeenAt: jest.fn(),
      persistDailyActivity: jest.fn(),
      presenceIdleAfterMinutes: jest.fn().mockReturnValue(5),
      unsubscribeOnlineFeed: jest.fn(),
    });
    const presenceRedis = {
      setIdle: jest.fn().mockResolvedValue(undefined),
      setActive: jest.fn().mockResolvedValue(undefined),
      touchSocket: jest.fn().mockResolvedValue(undefined),
    } as any;
    const handler = new PresenceStatusHandler(
      { isProd: jest.fn().mockReturnValue(true), marvBot: jest.fn().mockReturnValue({ enabled: false }) } as any,
      {} as any,
      presence,
      presenceRedis,
      { getFollowListUsersByIds: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
      {} as any,
      {} as any,
      new GatewayThrottleService(),
      makeContext(presence, server),
    );
    return { server, presence, presenceRedis, handler };
  }

  it('presence:idle marks the user idle and fans out presence:idle to subscribers', () => {
    const { server, presence, presenceRedis, handler } = makePresenceHandlerFixture();
    presence.getUserIdForSocket.mockReturnValue('u1');
    const subscriber = new FakeSocket('s-sub');
    server.register(subscriber);
    presence.getSubscribers.mockReturnValue(new Set(['s-sub']));

    handler.handleIdle(new FakeSocket('s1') as any);

    expect(presence.setUserIdle).toHaveBeenCalledWith('u1');
    expect(presenceRedis.setIdle).toHaveBeenCalledWith('u1');
    expect(subscriber.lastEmitted('presence:idle')).toEqual({ userId: 'u1' });
  });

  it('presence:active emits presence:active only when the user was idle', () => {
    jest.useFakeTimers();
    try {
      const { server, presence, handler } = makePresenceHandlerFixture();
      presence.getUserIdForSocket.mockReturnValue('u1');
      const subscriber = new FakeSocket('s-sub');
      server.register(subscriber);
      presence.getSubscribers.mockReturnValue(new Set(['s-sub']));

      presence.isUserIdle.mockReturnValue(false);
      handler.handleActive(new FakeSocket('s1') as any);
      expect(subscriber.allEmitted('presence:active')).toHaveLength(0);

      presence.isUserIdle.mockReturnValue(true);
      handler.handleActive(new FakeSocket('s1') as any);
      expect(subscriber.lastEmitted('presence:active')).toEqual({ userId: 'u1' });
    } finally {
      jest.useRealTimers();
    }
  });
});

// ─── CommunityGroupReadAccessService ─────────────────────────────────────────

describe('CommunityGroupReadAccessService', () => {
  function makeService(opts: {
    group?: { joinPolicy: 'open' | 'approval' } | null;
    membership?: { status: string } | null;
    viewer?: Record<string, unknown> | null;
    isVerified?: boolean;
  }) {
    const prisma = {
      communityGroup: {
        findFirst: jest.fn().mockResolvedValue(opts.group ?? null),
        findMany: jest.fn().mockResolvedValue(opts.group ? [{ id: 'g1', joinPolicy: opts.group.joinPolicy }] : []),
      },
      communityGroupMember: {
        findUnique: jest.fn().mockResolvedValue(opts.membership ?? null),
        findMany: jest.fn().mockResolvedValue(opts.membership?.status === 'active' ? [{ groupId: 'g1' }] : []),
      },
    } as any;
    const viewerContextService = {
      getViewer: jest.fn().mockResolvedValue(opts.viewer ?? null),
      isVerified: jest.fn().mockReturnValue(Boolean(opts.isVerified)),
    } as any;
    return new CommunityGroupReadAccessService(prisma, viewerContextService);
  }

  it('assertCanRead: 404s for an unknown group', async () => {
    const svc = makeService({ group: null });
    await expect(svc.assertCanRead('u1', 'missing')).rejects.toThrow('Group not found.');
  });

  it('assertCanRead: allows site admins regardless of membership', async () => {
    const svc = makeService({ group: { joinPolicy: 'approval' }, viewer: { siteAdmin: true } });
    await expect(svc.assertCanRead('u1', 'g1')).resolves.toBeUndefined();
  });

  it('assertCanRead: allows verified viewers into open groups', async () => {
    const svc = makeService({ group: { joinPolicy: 'open' }, viewer: {}, isVerified: true });
    await expect(svc.assertCanRead('u1', 'g1')).resolves.toBeUndefined();
  });

  it('assertCanRead: rejects unverified viewers from open groups', async () => {
    const svc = makeService({ group: { joinPolicy: 'open' }, viewer: {}, isVerified: false });
    await expect(svc.assertCanRead('u1', 'g1')).rejects.toThrow('Verify your account to view groups.');
  });

  it('assertCanRead: rejects non-members of approval groups', async () => {
    const svc = makeService({ group: { joinPolicy: 'approval' }, viewer: {}, membership: null });
    await expect(svc.assertCanRead('u1', 'g1')).rejects.toThrow('You are not a member of this group.');
  });

  it('assertCanRead: allows active members of approval groups', async () => {
    const svc = makeService({ group: { joinPolicy: 'approval' }, viewer: {}, membership: { status: 'active' } });
    await expect(svc.assertCanRead('u1', 'g1')).resolves.toBeUndefined();
  });

  it('filterReadableGroupIds: active member yes, anonymous into approval group no', async () => {
    const memberSvc = makeService({ group: { joinPolicy: 'approval' }, membership: { status: 'active' } });
    await expect(
      memberSvc.filterReadableGroupIds({ viewerUserId: 'u1', viewerIsAdmin: false, viewerIsVerified: true, groupIds: ['g1'] }),
    ).resolves.toEqual(new Set(['g1']));

    const anonSvc = makeService({ group: { joinPolicy: 'approval' } });
    await expect(
      anonSvc.filterReadableGroupIds({ viewerUserId: null, viewerIsAdmin: false, viewerIsVerified: false, groupIds: ['g1'] }),
    ).resolves.toEqual(new Set());
  });

  it('filterReadableGroupIds: open group requires verification', async () => {
    const svc = makeService({ group: { joinPolicy: 'open' } });
    await expect(
      svc.filterReadableGroupIds({ viewerUserId: 'u1', viewerIsAdmin: false, viewerIsVerified: true, groupIds: ['g1'] }),
    ).resolves.toEqual(new Set(['g1']));
    await expect(
      svc.filterReadableGroupIds({ viewerUserId: 'u1', viewerIsAdmin: false, viewerIsVerified: false, groupIds: ['g1'] }),
    ).resolves.toEqual(new Set());
  });
});
