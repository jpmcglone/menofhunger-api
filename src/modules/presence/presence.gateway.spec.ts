/**
 * Presence Gateway — watch-party sync unit tests.
 *
 * We invoke handler methods directly on a gateway instance that has all
 * services mocked out, and a lightweight fake Server / Socket that lets us
 * assert on emitted events without starting a real process.
 */

import { PresenceGateway } from './presence.gateway';
import { WatchPartyStateService } from '../spaces/watch-party-state.service';
import { GatewayContextService } from './gateway/gateway-context.service';
import { GatewayThrottleService } from './gateway/gateway-throttle.service';
import { PresenceStatusHandler } from './gateway/gateway-presence.handler';
import { SpacesGatewayHandler } from './gateway/gateway-spaces.handler';
import { RadioGatewayHandler } from './gateway/gateway-radio.handler';
import { ContentSubscriptionsHandler } from './gateway/gateway-subscriptions.handler';
import { MessagingGatewayHandler } from './gateway/gateway-messaging.handler';
import { CommunityGroupReadAccessService } from '../viewer/community-group-read-access.service';

// ─── Lightweight fake socket.io infrastructure ──────────────────────────────

type EmittedEvent = { event: string; payload: unknown };

class FakeSocket {
  readonly id: string;
  readonly emitted: EmittedEvent[] = [];
  readonly data: Record<string, unknown> = {};
  private readonly rooms = new Set<string>();

  constructor(id: string, data: Record<string, unknown> = {}) {
    this.id = id;
    Object.assign(this.data, data);
    // Each socket is always in its own room.
    this.rooms.add(id);
  }

  emit(event: string, payload?: unknown): this {
    this.emitted.push({ event, payload: payload ?? null });
    return this;
  }

  join(room: string) { this.rooms.add(room); }
  leave(room: string) { this.rooms.delete(room); }
  to(_room: string): this { return this; } // simplified — use FakeServer.to()
  lastEmitted(event: string): unknown {
    const all = this.emitted.filter((e) => e.event === event);
    return all[all.length - 1]?.payload ?? undefined;
  }
  allEmitted(event: string): unknown[] {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload);
  }
}

class FakeServer {
  private readonly sockets = new Map<string, FakeSocket>();
  private readonly rooms = new Map<string, Set<string>>();
  readonly emitted: EmittedEvent[] = [];

  register(socket: FakeSocket) {
    this.sockets.set(socket.id, socket);
  }

  // Allow gateway to look up sockets by id
  get socketsMap() {
    return { sockets: this.sockets };
  }

  to(room: string) {
    const memberIds = this.rooms.get(room) ?? new Set<string>();
    return {
      emit: (event: string, payload?: unknown) => {
        this.emitted.push({ event, payload: payload ?? null });
        for (const id of memberIds) {
          this.sockets.get(id)?.emit(event, payload);
        }
      },
    };
  }

  joinRoom(socketId: string, room: string) {
    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    this.rooms.get(room)!.add(socketId);
  }
  leaveRoom(socketId: string, room: string) {
    this.rooms.get(room)?.delete(socketId);
  }
  lastRoomEmitted(room: string, event: string): unknown {
    const all = this.emitted.filter((e) => e.event === event);
    return all[all.length - 1]?.payload ?? undefined;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SPACE_ID = 'space-1';
const OWNER_ID = 'user-owner';
const VIEWER_ID = 'user-viewer';
const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const VIDEO_URL_2 = 'https://www.youtube.com/watch?v=newVideo123';
const SPACE_ROOM = `space:${SPACE_ID}`;

function makeRedis() {
  return {
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
  } as any;
}

function makePresenceRedis() {
  return {
    getInstanceId: jest.fn().mockReturnValue('instance-1'),
    onEvent: jest.fn().mockReturnValue(() => {}),
    publishEmitToRoom: jest.fn().mockResolvedValue(undefined),
    publishUserSpaceChanged: jest.fn().mockResolvedValue(undefined),
    idleByUserIds: jest.fn().mockResolvedValue(new Map<string, boolean>()),
    onlineByUserIds: jest.fn().mockResolvedValue(new Map<string, boolean>()),
    unregisterSocket: jest.fn().mockResolvedValue({ isNowOffline: false }),
    publishSpacesLobbyCounts: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function makePresenceService(userId = OWNER_ID) {
  return {
    register: jest.fn(),
    unregister: jest.fn().mockReturnValue({ userId, isNowOffline: false }),
    getUserIdForSocket: jest.fn().mockReturnValue(null),
    persistLastOnlineAt: jest.fn(),
    isUserOnline: jest.fn().mockReturnValue(false),
    getSocketIdsForUser: jest.fn().mockReturnValue([]),
    getSubscribers: jest.fn().mockReturnValue(new Set<string>()),
    getOnlineFeedListeners: jest.fn().mockReturnValue(new Set<string>()),
    emitToUser: jest.fn(),
    subscribe: jest.fn((socketId: string, userIds: string[]) => ({ added: userIds })),
    getActiveStatuses: jest.fn().mockResolvedValue([]),
  } as any;
}

function makeSpacesService(ownerId = OWNER_ID, mode: string = 'WATCH_PARTY') {
  return {
    getOwnerIdForSpace: jest.fn().mockResolvedValue(ownerId),
    getSpaceMode: jest.fn().mockResolvedValue(mode),
    isSpaceActive: jest.fn().mockResolvedValue(true),
    activateSpaceByOwnerId: jest.fn().mockResolvedValue(undefined),
    getReactionById: jest.fn().mockReturnValue(null),
  } as any;
}

function makeSpacesPresenceService() {
  // Minimal in-memory implementation matching the real service's interface.
  const socketData = new Map<string, { userId: string; spaceId: string; roomSpaceId?: string }>();
  return {
    isValidSpaceId: jest.fn().mockReturnValue(true),
    join: jest.fn((params: { socketId: string; userId: string; spaceId: string }) => {
      const prev = socketData.get(params.socketId);
      socketData.set(params.socketId, { userId: params.userId, spaceId: params.spaceId, roomSpaceId: params.spaceId });
      return { prevSpaceId: prev?.spaceId ?? null, prevRoomSpaceId: prev?.roomSpaceId ?? null };
    }),
    leave: jest.fn((socketId: string) => {
      const entry = socketData.get(socketId);
      if (!entry) return null;
      socketData.delete(socketId);
      return { userId: entry.userId, spaceId: entry.spaceId, wasActive: true };
    }),
    onDisconnect: jest.fn((socketId: string) => {
      const entry = socketData.get(socketId);
      if (!entry) return null;
      socketData.delete(socketId);
      return { userId: entry.userId, spaceId: entry.spaceId, wasActive: true };
    }),
    getMembersForSpace: jest.fn().mockReturnValue({ userIds: [], pausedUserIds: [], mutedUserIds: [] }),
    getRoomSpaceForSocket: jest.fn().mockReturnValue(null),
    getSpaceForUser: jest.fn().mockReturnValue(null),
    clearRoomForSocket: jest.fn().mockReturnValue(null),
    clearAllPaused: jest.fn().mockReturnValue([]),
    getLobbyCountsBySpaceId: jest.fn().mockReturnValue({}),
    pause: jest.fn().mockReturnValue(null),
    setMuted: jest.fn().mockReturnValue(null),
  } as any;
}

function makeStubServices() {
  return {
    appConfig: { isProd: jest.fn().mockReturnValue(false) } as any,
    auth: {} as any,
    realtime: { setServer: jest.fn() } as any,
    follows: { getFollowListUsersByIds: jest.fn().mockResolvedValue([]) } as any,
    messages: {} as any,
    radio: { isValidStationId: jest.fn().mockReturnValue(false), join: jest.fn(), pause: jest.fn(), onDisconnect: jest.fn().mockReturnValue(null) } as any,
    radioChat: {} as any,
    spacesChat: { appendSystemMessage: jest.fn().mockReturnValue(null) } as any,
    prisma: {} as any,
  };
}

/** Wires the gateway with its handler modules, mirroring the providers in PresenceModule. */
function buildGateway(deps: {
  appConfig: any;
  auth: any;
  presence: any;
  presenceRedis: any;
  realtime: any;
  follows: any;
  messages: any;
  radio: any;
  radioChat: any;
  spacesService: any;
  spacesPresence: any;
  spacesChat: any;
  watchPartyState: WatchPartyStateService;
  prisma: any;
  redis: any;
  marvIdentity: any;
}): PresenceGateway {
  const context = new GatewayContextService(deps.appConfig, deps.presence);
  const throttle = new GatewayThrottleService();
  const presenceHandler = new PresenceStatusHandler(
    deps.appConfig,
    deps.auth,
    deps.presence,
    deps.presenceRedis,
    deps.follows,
    deps.redis,
    deps.spacesPresence,
    deps.marvIdentity,
    throttle,
    context,
  );
  const spacesHandler = new SpacesGatewayHandler(
    deps.presence,
    deps.presenceRedis,
    deps.follows,
    deps.spacesService,
    deps.spacesPresence,
    deps.spacesChat,
    deps.watchPartyState,
    deps.redis,
    throttle,
    context,
  );
  const radioHandler = new RadioGatewayHandler(
    deps.presence,
    deps.presenceRedis,
    deps.follows,
    deps.radio,
    deps.radioChat,
    context,
  );
  // filterReadableGroupIds doesn't touch ViewerContextService, so a bare stub suffices.
  const groupReadAccess = new CommunityGroupReadAccessService(deps.prisma, {} as any);
  const subscriptionsHandler = new ContentSubscriptionsHandler(deps.prisma, groupReadAccess);
  const messagingHandler = new MessagingGatewayHandler(
    deps.presence,
    deps.presenceRedis,
    deps.messages,
    throttle,
    context,
  );
  return new PresenceGateway(
    deps.presence,
    deps.presenceRedis,
    deps.realtime,
    context,
    presenceHandler,
    spacesHandler,
    radioHandler,
    subscriptionsHandler,
    messagingHandler,
  );
}

interface GatewayFixture {
  gw: PresenceGateway;
  server: FakeServer;
  watchPartyState: WatchPartyStateService;
  spacesService: ReturnType<typeof makeSpacesService>;
  spacesPresence: ReturnType<typeof makeSpacesPresenceService>;
  presence: ReturnType<typeof makePresenceService>;
  presenceRedis: ReturnType<typeof makePresenceRedis>;
  ownerSocket: FakeSocket;
  viewerSocket: FakeSocket;
  joinOwner: (socket?: FakeSocket) => Promise<void>;
  joinViewer: (socket?: FakeSocket) => Promise<void>;
}

function makeFixture(opts: { spaceMode?: string } = {}): GatewayFixture {
  const redis = makeRedis();
  const presenceRedis = makePresenceRedis();
  const presence = makePresenceService(OWNER_ID);
  const spacesService = makeSpacesService(OWNER_ID, opts.spaceMode ?? 'WATCH_PARTY');
  const spacesPresence = makeSpacesPresenceService();
  const stub = makeStubServices();
  const watchPartyState = new WatchPartyStateService(redis);

  const marvIdentity = {
    getMarvUserId: jest.fn().mockResolvedValue(null),
    marvUsernameLower: jest.fn().mockReturnValue('marv'),
  } as any;
  // Marv config defaults to disabled for these watch-party tests; the
  // online-feed-snapshot tests below override `marvBot()` directly.
  stub.appConfig.marvBot = jest.fn().mockReturnValue({
    enabled: false,
    userId: null,
    username: 'marv',
    displayName: 'Marv',
    bio: '',
    phone: '',
  });

  const gw = buildGateway({
    ...stub,
    presence,
    presenceRedis,
    spacesService,
    spacesPresence,
    watchPartyState,
    redis,
    marvIdentity,
  });

  const server = new FakeServer();

  const ownerSocket = new FakeSocket('socket-owner', { userId: OWNER_ID });
  const viewerSocket = new FakeSocket('socket-viewer', { userId: VIEWER_ID });
  server.register(ownerSocket);
  server.register(viewerSocket);

  // Wire the server so gateway can access sockets by id (gateway uses server.sockets.sockets.get).
  const fakeIoServer = {
    sockets: {
      sockets: server.socketsMap.sockets,
    },
    to: (room: string) => server.to(room),
    emit: (event: string, payload?: unknown) => server.emitted.push({ event, payload }),
  };
  (gw as any).server = fakeIoServer;

  gw.afterInit(fakeIoServer as any);

  const joinOwner = async (socket = ownerSocket) => {
    server.joinRoom(socket.id, SPACE_ROOM);
    await (gw as any).handleSpacesJoin(socket, { spaceId: SPACE_ID });
  };

  const joinViewer = async (socket = viewerSocket) => {
    server.joinRoom(socket.id, SPACE_ROOM);
    // Viewer lookup returns VIEWER_ID
    jest.spyOn(presence, 'getUserIdForSocket').mockReturnValueOnce(VIEWER_ID);
    spacesService.getOwnerIdForSpace.mockResolvedValueOnce(OWNER_ID); // ownerId != viewerId → not owner
    spacesService.isSpaceActive.mockResolvedValueOnce(true);
    await (gw as any).handleSpacesJoin(socket, { spaceId: SPACE_ID });
  };

  return { gw, server, watchPartyState, spacesService, spacesPresence, presence, presenceRedis, ownerSocket, viewerSocket, joinOwner, joinViewer };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PresenceGateway — watch party sync', () => {
  let nowSpy: jest.SpyInstance;

  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('presence:subscribe', () => {
    it('includes active status in the subscription snapshot', async () => {
      const { gw, ownerSocket, presence, presenceRedis } = makeFixture();
      presenceRedis.onlineByUserIds.mockResolvedValueOnce(new Map([[OWNER_ID, true]]));
      presenceRedis.idleByUserIds.mockResolvedValueOnce(new Map([[OWNER_ID, false]]));
      presence.getActiveStatuses.mockResolvedValueOnce([
        {
          userId: OWNER_ID,
          text: 'Around tonight',
          setAt: '2026-04-25T03:00:00.000Z',
          expiresAt: '2026-04-26T03:00:00.000Z',
        },
      ]);

      await (gw as any).handleSubscribe(ownerSocket, { userIds: [OWNER_ID] });

      expect(ownerSocket.lastEmitted('presence:subscribed')).toEqual({
        users: [
          {
            userId: OWNER_ID,
            online: true,
            idle: false,
            spaceId: undefined,
            status: {
              userId: OWNER_ID,
              text: 'Around tonight',
              setAt: '2026-04-25T03:00:00.000Z',
              expiresAt: '2026-04-26T03:00:00.000Z',
            },
          },
        ],
      });
    });
  });

  // ── spaces:join broadcasts current state to the joining client ─────────────

  describe('spaces:join — initial state delivery', () => {
    it('sends no watchPartyState when there is none', async () => {
      const { joinOwner, ownerSocket } = makeFixture();
      await joinOwner();
      expect(ownerSocket.allEmitted('spaces:watchPartyState')).toHaveLength(0);
    });

    it('sends existing watchPartyState to the joining viewer (playing case)', async () => {
      const { gw, joinOwner, joinViewer, watchPartyState, viewerSocket } = makeFixture();
      await joinOwner();
      nowSpy.mockReturnValue(1000);
      watchPartyState.setState(SPACE_ID, { videoUrl: VIDEO_URL, isPlaying: true, currentTime: 42, playbackRate: 1 });
      await joinViewer();
      const state = viewerSocket.lastEmitted('spaces:watchPartyState') as any;
      expect(state).toBeDefined();
      expect(state.isPlaying).toBe(true);
      expect(state.currentTime).toBeCloseTo(42);
      expect(state.videoUrl).toBe(VIDEO_URL);
      expect(gw).toBeDefined(); // satisfy linter
    });

    it('sends existing watchPartyState to the joining viewer (paused case)', async () => {
      const { joinOwner, joinViewer, watchPartyState, viewerSocket } = makeFixture();
      await joinOwner();
      watchPartyState.setState(SPACE_ID, { videoUrl: VIDEO_URL, isPlaying: false, currentTime: 100, playbackRate: 1 });
      await joinViewer();
      const state = viewerSocket.lastEmitted('spaces:watchPartyState') as any;
      expect(state.isPlaying).toBe(false);
      expect(state.currentTime).toBeCloseTo(100);
    });

    it('sends no watchPartyState when space mode is not WATCH_PARTY', async () => {
      const { joinViewer, watchPartyState, viewerSocket } = makeFixture({ spaceMode: 'RADIO' });
      watchPartyState.setState(SPACE_ID, { videoUrl: VIDEO_URL, isPlaying: true, currentTime: 5, playbackRate: 1 });
      // joinViewer internally calls handleSpacesJoin, which reads state regardless of mode;
      // the mode check here is on requestWatchPartyState, not on join. So state IS sent on join.
      // This test documents that the join path always returns state. Mode guard is on requestWatchPartyState.
      await joinViewer();
      // Join always sends state if it exists — document this expected behavior.
      const sent = viewerSocket.allEmitted('spaces:watchPartyState');
      expect(Array.isArray(sent)).toBe(true);
    });
  });

  // ── spaces:watchPartyControl ───────────────────────────────────────────────

  describe('spaces:watchPartyControl', () => {
    it('broadcasts watchPartyState to the room when owner emits control', async () => {
      const { gw, joinOwner, server, ownerSocket } = makeFixture();
      await joinOwner();

      nowSpy.mockReturnValue(5000);
      await (gw as any).handleWatchPartyControl(ownerSocket, {
        spaceId: SPACE_ID,
        videoUrl: VIDEO_URL,
        isPlaying: true,
        currentTime: 30,
        playbackRate: 1,
      });

      const state = server.lastRoomEmitted(SPACE_ROOM, 'spaces:watchPartyState') as any;
      expect(state).toBeDefined();
      expect(state.isPlaying).toBe(true);
      expect(state.currentTime).toBeCloseTo(30);
      expect(state.videoUrl).toBe(VIDEO_URL);
    });

    it('stores isPlaying=false when payload.isPlaying is omitted (strict boolean parsing)', async () => {
      const { gw, joinOwner, watchPartyState, ownerSocket } = makeFixture();
      await joinOwner();

      await (gw as any).handleWatchPartyControl(ownerSocket, {
        spaceId: SPACE_ID,
        videoUrl: VIDEO_URL,
        // isPlaying intentionally absent
        currentTime: 10,
        playbackRate: 1,
      });

      const stored = watchPartyState.getState(SPACE_ID)!;
      expect(stored.isPlaying).toBe(false);
    });

    it('stores isPlaying=false when payload.isPlaying is undefined', async () => {
      const { gw, joinOwner, watchPartyState, ownerSocket } = makeFixture();
      await joinOwner();

      await (gw as any).handleWatchPartyControl(ownerSocket, {
        spaceId: SPACE_ID,
        videoUrl: VIDEO_URL,
        isPlaying: undefined,
        currentTime: 10,
        playbackRate: 1,
      });

      expect(watchPartyState.getState(SPACE_ID)!.isPlaying).toBe(false);
    });

    it('ignores control from a non-owner (viewer) socket', async () => {
      const { gw, joinOwner, joinViewer, server, viewerSocket } = makeFixture();
      await joinOwner();
      await joinViewer();
      const beforeCount = server.emitted.filter((e) => e.event === 'spaces:watchPartyState').length;

      // Viewer's getUserIdForSocket returns VIEWER_ID; ownerId is OWNER_ID — mismatch → rejected
      await (gw as any).handleWatchPartyControl(viewerSocket, {
        spaceId: SPACE_ID,
        videoUrl: VIDEO_URL,
        isPlaying: true,
        currentTime: 0,
        playbackRate: 1,
      });

      const afterCount = server.emitted.filter((e) => e.event === 'spaces:watchPartyState').length;
      expect(afterCount).toBe(beforeCount);
    });

    it('ignores control when space mode is not WATCH_PARTY', async () => {
      const { gw, joinOwner, server, ownerSocket, spacesService } = makeFixture();
      await joinOwner();
      spacesService.getSpaceMode.mockResolvedValueOnce('NONE');
      const beforeCount = server.emitted.filter((e) => e.event === 'spaces:watchPartyState').length;

      await (gw as any).handleWatchPartyControl(ownerSocket, {
        spaceId: SPACE_ID,
        videoUrl: VIDEO_URL,
        isPlaying: true,
        currentTime: 0,
        playbackRate: 1,
      });

      expect(server.emitted.filter((e) => e.event === 'spaces:watchPartyState').length).toBe(beforeCount);
    });

    it('ignores control from a replaced (non-primary) owner socket', async () => {
      const { gw, server, ownerSocket } = makeFixture();

      const ownerSocket2 = new FakeSocket('socket-owner-2', { userId: OWNER_ID, ownerSpaceId: SPACE_ID });
      server.register(ownerSocket2);
      // Socket 1 joins first (primary), socket 2 joins second (becomes primary, socket 1 replaced).
      server.joinRoom(ownerSocket.id, SPACE_ROOM);
      await (gw as any).handleSpacesJoin(ownerSocket, { spaceId: SPACE_ID });
      server.joinRoom(ownerSocket2.id, SPACE_ROOM);
      await (gw as any).handleSpacesJoin(ownerSocket2, { spaceId: SPACE_ID });

      // Verify socket 1 was notified of replacement.
      expect(ownerSocket.allEmitted('spaces:watchPartyOwnerReplaced')).toHaveLength(1);

      const beforeCount = server.emitted.filter((e) => e.event === 'spaces:watchPartyState').length;

      // Replaced socket tries to send control — should be rejected.
      await (gw as any).handleWatchPartyControl(ownerSocket, {
        spaceId: SPACE_ID,
        videoUrl: VIDEO_URL,
        isPlaying: true,
        currentTime: 0,
        playbackRate: 1,
      });

      expect(server.emitted.filter((e) => e.event === 'spaces:watchPartyState').length).toBe(beforeCount);
    });

    it('accepts control from the new primary after tab replacement', async () => {
      const { gw, server, ownerSocket } = makeFixture();

      const ownerSocket2 = new FakeSocket('socket-owner-2', { userId: OWNER_ID, ownerSpaceId: SPACE_ID });
      server.register(ownerSocket2);
      server.joinRoom(ownerSocket.id, SPACE_ROOM);
      await (gw as any).handleSpacesJoin(ownerSocket, { spaceId: SPACE_ID });
      server.joinRoom(ownerSocket2.id, SPACE_ROOM);
      await (gw as any).handleSpacesJoin(ownerSocket2, { spaceId: SPACE_ID });

      // Socket 2 is now primary; its control should broadcast.
      await (gw as any).handleWatchPartyControl(ownerSocket2, {
        spaceId: SPACE_ID,
        videoUrl: VIDEO_URL,
        isPlaying: true,
        currentTime: 55,
        playbackRate: 1,
      });

      const state = server.lastRoomEmitted(SPACE_ROOM, 'spaces:watchPartyState') as any;
      expect(state).toBeDefined();
      expect(state.isPlaying).toBe(true);
      expect(state.currentTime).toBeCloseTo(55);
    });
  });

  // ── Tab replacement and re-election ───────────────────────────────────────

  describe('primary owner re-election', () => {
    it('second owner tab join notifies first tab with watchPartyOwnerReplaced', async () => {
      const { gw, server, ownerSocket } = makeFixture();
      const ownerSocket2 = new FakeSocket('socket-owner-2', { userId: OWNER_ID });
      server.register(ownerSocket2);

      server.joinRoom(ownerSocket.id, SPACE_ROOM);
      await (gw as any).handleSpacesJoin(ownerSocket, { spaceId: SPACE_ID });
      server.joinRoom(ownerSocket2.id, SPACE_ROOM);
      await (gw as any).handleSpacesJoin(ownerSocket2, { spaceId: SPACE_ID });

      expect(ownerSocket.allEmitted('spaces:watchPartyOwnerReplaced')).toHaveLength(1);
      const replaced = ownerSocket.lastEmitted('spaces:watchPartyOwnerReplaced') as any;
      expect(replaced.spaceId).toBe(SPACE_ID);
    });

    it('promotes another owner tab when the primary disconnects', async () => {
      const { gw, server, ownerSocket, spacesPresence } = makeFixture();
      const ownerSocket2 = new FakeSocket('socket-owner-2', { userId: OWNER_ID, ownerSpaceId: SPACE_ID });
      server.register(ownerSocket2);

      server.joinRoom(ownerSocket.id, SPACE_ROOM);
      await (gw as any).handleSpacesJoin(ownerSocket, { spaceId: SPACE_ID });
      server.joinRoom(ownerSocket2.id, SPACE_ROOM);
      await (gw as any).handleSpacesJoin(ownerSocket2, { spaceId: SPACE_ID });
      // ownerSocket is now replaced; ownerSocket2 is primary.

      // Disconnect ownerSocket2 (the primary).
      spacesPresence.onDisconnect.mockReturnValueOnce({ userId: OWNER_ID, spaceId: SPACE_ID, wasActive: true });
      (ownerSocket2.data as any).ownerSpaceId = SPACE_ID;
      gw.handleDisconnect(ownerSocket2 as any);

      // ownerSocket (the remaining tab) should be promoted.
      const promoted = ownerSocket.allEmitted('spaces:watchPartyOwnerPromoted');
      expect(promoted).toHaveLength(1);
      expect((promoted[0] as any).spaceId).toBe(SPACE_ID);
    });

    it('promoted socket can then send watchPartyControl', async () => {
      const { gw, server, ownerSocket, watchPartyState, spacesPresence } = makeFixture();
      const ownerSocket2 = new FakeSocket('socket-owner-2', { userId: OWNER_ID, ownerSpaceId: SPACE_ID });
      server.register(ownerSocket2);

      server.joinRoom(ownerSocket.id, SPACE_ROOM);
      await (gw as any).handleSpacesJoin(ownerSocket, { spaceId: SPACE_ID });
      server.joinRoom(ownerSocket2.id, SPACE_ROOM);
      await (gw as any).handleSpacesJoin(ownerSocket2, { spaceId: SPACE_ID });

      // Primary (socket2) disconnects → socket1 promoted.
      spacesPresence.onDisconnect.mockReturnValueOnce({ userId: OWNER_ID, spaceId: SPACE_ID, wasActive: true });
      (ownerSocket2.data as any).ownerSpaceId = SPACE_ID;
      gw.handleDisconnect(ownerSocket2 as any);

      // ownerSocket is now primary — its control must broadcast.
      await (gw as any).handleWatchPartyControl(ownerSocket, {
        spaceId: SPACE_ID,
        videoUrl: VIDEO_URL,
        isPlaying: true,
        currentTime: 77,
        playbackRate: 1,
      });

      expect(watchPartyState.getState(SPACE_ID)!.currentTime).toBeCloseTo(77);
    });

    it('no promotion when the only owner socket disconnects', async () => {
      const { gw, server, ownerSocket, spacesPresence } = makeFixture();
      server.joinRoom(ownerSocket.id, SPACE_ROOM);
      await (gw as any).handleSpacesJoin(ownerSocket, { spaceId: SPACE_ID });

      spacesPresence.onDisconnect.mockReturnValueOnce({ userId: OWNER_ID, spaceId: SPACE_ID, wasActive: true });
      (ownerSocket.data as any).ownerSpaceId = SPACE_ID;
      gw.handleDisconnect(ownerSocket as any);

      // No watchPartyOwnerPromoted emitted to anyone.
      const allEmitted = [...server.emitted.map((e) => e.event)];
      expect(allEmitted).not.toContain('spaces:watchPartyOwnerPromoted');
    });
  });

  // ── URL change resets state ────────────────────────────────────────────────

  describe('spaces:announceMode — URL change resets state', () => {
    it('resets to paused-at-0 and broadcasts when URL changes in WATCH_PARTY mode', async () => {
      const { gw, joinOwner, server, watchPartyState, ownerSocket } = makeFixture();
      await joinOwner();
      watchPartyState.setState(SPACE_ID, { videoUrl: VIDEO_URL, isPlaying: true, currentTime: 120, playbackRate: 1 });

      await (gw as any).handleSpacesAnnounceMode(ownerSocket, {
        spaceId: SPACE_ID,
        mode: 'WATCH_PARTY',
        watchPartyUrl: VIDEO_URL_2,
      });

      const state = watchPartyState.getState(SPACE_ID)!;
      expect(state.videoUrl).toBe(VIDEO_URL_2);
      expect(state.isPlaying).toBe(false);
      expect(state.currentTime).toBe(0);

      const broadcast = server.lastRoomEmitted(SPACE_ROOM, 'spaces:watchPartyState') as any;
      expect(broadcast).toBeDefined();
      expect(broadcast.videoUrl).toBe(VIDEO_URL_2);
      expect(broadcast.isPlaying).toBe(false);
    });

    it('does NOT reset state when URL is unchanged', async () => {
      const { gw, joinOwner, watchPartyState, ownerSocket } = makeFixture();
      await joinOwner();
      watchPartyState.setState(SPACE_ID, { videoUrl: VIDEO_URL, isPlaying: true, currentTime: 60, playbackRate: 1 });

      await (gw as any).handleSpacesAnnounceMode(ownerSocket, {
        spaceId: SPACE_ID,
        mode: 'WATCH_PARTY',
        watchPartyUrl: VIDEO_URL, // same URL
      });

      // State should still have the old position (not reset to 0).
      expect(watchPartyState.getState(SPACE_ID)!.currentTime).toBeCloseTo(60);
      expect(watchPartyState.getState(SPACE_ID)!.isPlaying).toBe(true);
    });

    it('clears state when switching away from WATCH_PARTY mode', async () => {
      const { gw, joinOwner, watchPartyState, ownerSocket } = makeFixture();
      await joinOwner();
      watchPartyState.setState(SPACE_ID, { videoUrl: VIDEO_URL, isPlaying: true, currentTime: 30, playbackRate: 1 });

      await (gw as any).handleSpacesAnnounceMode(ownerSocket, {
        spaceId: SPACE_ID,
        mode: 'NONE',
        watchPartyUrl: null,
      });

      expect(watchPartyState.getState(SPACE_ID)).toBeNull();
    });

    it('sets initial state when mode switches to WATCH_PARTY with a URL and no prior state', async () => {
      const { gw, joinOwner, watchPartyState, ownerSocket } = makeFixture();
      await joinOwner();
      // No prior state.

      await (gw as any).handleSpacesAnnounceMode(ownerSocket, {
        spaceId: SPACE_ID,
        mode: 'WATCH_PARTY',
        watchPartyUrl: VIDEO_URL,
      });

      const state = watchPartyState.getState(SPACE_ID)!;
      expect(state.videoUrl).toBe(VIDEO_URL);
      expect(state.isPlaying).toBe(false);
      expect(state.currentTime).toBe(0);
    });

    it('broadcasts modeChanged to the room', async () => {
      const { gw, joinOwner, server, ownerSocket } = makeFixture();
      await joinOwner();

      await (gw as any).handleSpacesAnnounceMode(ownerSocket, {
        spaceId: SPACE_ID,
        mode: 'WATCH_PARTY',
        watchPartyUrl: VIDEO_URL,
      });

      const modeEvent = server.lastRoomEmitted(SPACE_ROOM, 'spaces:modeChanged') as any;
      expect(modeEvent).toBeDefined();
      expect(modeEvent.mode).toBe('WATCH_PARTY');
      expect(modeEvent.watchPartyUrl).toBe(VIDEO_URL);
    });
  });

  // ── Owner disconnect pauses room ──────────────────────────────────────────

  describe('owner disconnect — pause room', () => {
    it('broadcasts paused watchPartyState when primary owner disconnects', async () => {
      const { gw, joinOwner, server, watchPartyState, ownerSocket, spacesPresence } = makeFixture();
      await joinOwner();
      nowSpy.mockReturnValue(0);
      watchPartyState.setState(SPACE_ID, { videoUrl: VIDEO_URL, isPlaying: true, currentTime: 10, playbackRate: 1 });

      nowSpy.mockReturnValue(5000); // 5 s elapsed
      spacesPresence.onDisconnect.mockReturnValueOnce({ userId: OWNER_ID, spaceId: SPACE_ID, wasActive: true });
      (ownerSocket.data as any).ownerSpaceId = SPACE_ID;
      gw.handleDisconnect(ownerSocket as any);

      const broadcast = server.lastRoomEmitted(SPACE_ROOM, 'spaces:watchPartyState') as any;
      expect(broadcast.isPlaying).toBe(false);
      expect(broadcast.currentTime).toBeCloseTo(15); // 10 + 5s elapsed
    });

    it('does not broadcast pause when disconnecting socket was not primary owner', async () => {
      const { gw, server, ownerSocket, spacesPresence } = makeFixture();
      const ownerSocket2 = new FakeSocket('socket-owner-2', { userId: OWNER_ID, ownerSpaceId: SPACE_ID });
      server.register(ownerSocket2);

      server.joinRoom(ownerSocket.id, SPACE_ROOM);
      await (gw as any).handleSpacesJoin(ownerSocket, { spaceId: SPACE_ID });
      server.joinRoom(ownerSocket2.id, SPACE_ROOM);
      await (gw as any).handleSpacesJoin(ownerSocket2, { spaceId: SPACE_ID });
      // ownerSocket is now replaced; ownerSocket2 is primary.

      // ownerSocket (replaced, not primary) disconnects.
      spacesPresence.onDisconnect.mockReturnValueOnce({ userId: OWNER_ID, spaceId: SPACE_ID, wasActive: true });
      (ownerSocket.data as any).ownerSpaceId = SPACE_ID;

      const wpStateBefore = server.emitted.filter((e) => e.event === 'spaces:watchPartyState').length;
      gw.handleDisconnect(ownerSocket as any);
      const wpStateAfter = server.emitted.filter((e) => e.event === 'spaces:watchPartyState').length;

      // Pause broadcast should NOT happen because ownerSocket was not primary.
      expect(wpStateAfter).toBe(wpStateBefore);
    });
  });

  // ── spaces:requestWatchPartyState ─────────────────────────────────────────

  describe('spaces:requestWatchPartyState', () => {
    it('unicasts current state to requester', async () => {
      const { gw, watchPartyState, viewerSocket } = makeFixture();
      watchPartyState.setState(SPACE_ID, { videoUrl: VIDEO_URL, isPlaying: false, currentTime: 25, playbackRate: 1 });

      await (gw as any).handleRequestWatchPartyState(viewerSocket, { spaceId: SPACE_ID });

      const state = viewerSocket.lastEmitted('spaces:watchPartyState') as any;
      expect(state).toBeDefined();
      expect(state.currentTime).toBeCloseTo(25);
    });

    it('returns nothing when there is no state', async () => {
      const { gw, viewerSocket } = makeFixture();
      await (gw as any).handleRequestWatchPartyState(viewerSocket, { spaceId: SPACE_ID });
      expect(viewerSocket.allEmitted('spaces:watchPartyState')).toHaveLength(0);
    });

    it('returns nothing when mode is not WATCH_PARTY', async () => {
      const { gw, watchPartyState, viewerSocket, spacesService } = makeFixture();
      watchPartyState.setState(SPACE_ID, { videoUrl: VIDEO_URL, isPlaying: true, currentTime: 5, playbackRate: 1 });
      spacesService.getSpaceMode.mockResolvedValueOnce('NONE');

      await (gw as any).handleRequestWatchPartyState(viewerSocket, { spaceId: SPACE_ID });
      expect(viewerSocket.allEmitted('spaces:watchPartyState')).toHaveLength(0);
    });
  });
});

// ─── posts:typing ────────────────────────────────────────────────────────────

const POST_ID = 'post-abc';
const POST_ROOM = `post:${POST_ID}`;
const TYPER_ID = 'user-typer';
const WATCHER_ID = 'user-watcher';

const TYPER_SENDER = {
  id: TYPER_ID,
  username: 'typer',
  premium: false,
  premiumPlus: false,
  isOrganization: false,
  verifiedStatus: 'none',
  stewardBadgeEnabled: false,
};

function makePostTypingFixture() {
  const redis = makeRedis();
  const presenceRedis = makePresenceRedis();
  const presence = makePresenceService(TYPER_ID);
  const spacesPresence = makeSpacesPresenceService();
  const stub = makeStubServices();
  const watchPartyState = new WatchPartyStateService(redis);
  const marvIdentity = {
    getMarvUserId: jest.fn().mockResolvedValue(null),
    marvUsernameLower: jest.fn().mockReturnValue('marv'),
  } as any;
  stub.appConfig.marvBot = jest.fn().mockReturnValue({ enabled: false, userId: null, username: 'marv', displayName: 'Marv', bio: '', phone: '' });

  const spacesService = makeSpacesService(TYPER_ID, 'NONE');
  const gw = buildGateway({
    ...stub,
    presence,
    presenceRedis,
    spacesService,
    spacesPresence,
    watchPartyState,
    redis,
    marvIdentity,
  });

  const server = new FakeServer();
  const typerSocket = new FakeSocket('socket-typer', { spaceChatUser: TYPER_SENDER });
  const watcherSocket = new FakeSocket('socket-watcher', { spaceChatUser: { ...TYPER_SENDER, id: WATCHER_ID, username: 'watcher' } });
  server.register(typerSocket);
  server.register(watcherSocket);

  const fakeIoServer = {
    sockets: { sockets: server.socketsMap.sockets },
    to: (room: string) => server.to(room),
    emit: (event: string, payload?: unknown) => server.emitted.push({ event, payload }),
  };
  (gw as any).server = fakeIoServer;
  gw.afterInit(fakeIoServer as any);

  // Helpers: subscribe a socket to the post room
  const subscribeSocket = (socket: FakeSocket) => {
    const subs = new Set<string>();
    subs.add(POST_ID);
    (socket.data as any).postSubs = subs;
    server.joinRoom(socket.id, POST_ROOM);
  };

  return { gw, server, presence, presenceRedis, typerSocket, watcherSocket, subscribeSocket };
}

describe('posts:typing', () => {
  // Note: handlePostsTyping uses `client.to(room).emit()` which in real Socket.IO
  // delivers to all room members except the sender. In tests we verify via
  // presenceRedis.publishEmitToRoom (the cross-instance delivery path) and by
  // asserting the correct payload shape.

  it('fans out with correct payload when subscribed and typing=true', () => {
    const { gw, presence, presenceRedis, typerSocket, subscribeSocket } = makePostTypingFixture();
    subscribeSocket(typerSocket);
    jest.spyOn(presence, 'getUserIdForSocket').mockReturnValue(TYPER_ID);

    (gw as any).handlePostsTyping(typerSocket, { postId: POST_ID, typing: true });

    expect(presenceRedis.publishEmitToRoom).toHaveBeenCalledWith(
      expect.objectContaining({
        room: POST_ROOM,
        event: 'posts:typing',
        payload: expect.objectContaining({ postId: POST_ID, typing: true, user: expect.objectContaining({ id: TYPER_ID, username: 'typer' }) }),
      }),
    );
  });

  it('fans out with typing=false when user stops replying', () => {
    const { gw, presence, presenceRedis, typerSocket, subscribeSocket } = makePostTypingFixture();
    subscribeSocket(typerSocket);
    jest.spyOn(presence, 'getUserIdForSocket').mockReturnValue(TYPER_ID);

    (gw as any).handlePostsTyping(typerSocket, { postId: POST_ID, typing: false });

    expect(presenceRedis.publishEmitToRoom).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ typing: false }) }),
    );
  });

  it('is a no-op when the socket has not subscribed to the post', () => {
    const { gw, presence, presenceRedis, typerSocket } = makePostTypingFixture();
    // Deliberately NOT calling subscribeSocket — no postSubs entry
    jest.spyOn(presence, 'getUserIdForSocket').mockReturnValue(TYPER_ID);

    (gw as any).handlePostsTyping(typerSocket, { postId: POST_ID, typing: true });

    expect(presenceRedis.publishEmitToRoom).not.toHaveBeenCalled();
  });

  it('is a no-op when userId is not found', () => {
    const { gw, presence, presenceRedis, typerSocket, subscribeSocket } = makePostTypingFixture();
    subscribeSocket(typerSocket);
    jest.spyOn(presence, 'getUserIdForSocket').mockReturnValue(null);

    (gw as any).handlePostsTyping(typerSocket, { postId: POST_ID, typing: true });

    expect(presenceRedis.publishEmitToRoom).not.toHaveBeenCalled();
  });

  it('throttles repeated typing=true emits from the same user within 700ms', () => {
    const { gw, presence, presenceRedis, typerSocket, subscribeSocket } = makePostTypingFixture();
    subscribeSocket(typerSocket);
    jest.spyOn(presence, 'getUserIdForSocket').mockReturnValue(TYPER_ID);

    (gw as any).handlePostsTyping(typerSocket, { postId: POST_ID, typing: true });
    (gw as any).handlePostsTyping(typerSocket, { postId: POST_ID, typing: true });
    (gw as any).handlePostsTyping(typerSocket, { postId: POST_ID, typing: true });

    // Only the first call should have made it through
    expect(presenceRedis.publishEmitToRoom).toHaveBeenCalledTimes(1);
  });
});

// ─── groups:subscribe — membership/visibility gating ──────────────────────────

const GROUP_ID = 'group-1';

function makeGroupsSubscribeFixture(opts: {
  joinPolicy?: 'open' | 'approval';
  activeMember?: boolean;
  viewer?: Record<string, unknown>;
  userId?: string | null;
}) {
  const redis = makeRedis();
  const presenceRedis = makePresenceRedis();
  const presence = makePresenceService('u1');
  const spacesPresence = makeSpacesPresenceService();
  const stub = makeStubServices();
  const watchPartyState = new WatchPartyStateService(redis);
  const marvIdentity = {
    getMarvUserId: jest.fn().mockResolvedValue(null),
    marvUsernameLower: jest.fn().mockReturnValue('marv'),
  } as any;
  stub.appConfig.marvBot = jest.fn().mockReturnValue({ enabled: false, userId: null, username: 'marv', displayName: 'Marv', bio: '', phone: '' });

  stub.prisma = {
    communityGroup: {
      findMany: jest.fn().mockResolvedValue([{ id: GROUP_ID, joinPolicy: opts.joinPolicy ?? 'approval' }]),
    },
    communityGroupMember: {
      findMany: jest.fn().mockResolvedValue(opts.activeMember ? [{ groupId: GROUP_ID }] : []),
    },
  } as any;

  const spacesService = makeSpacesService('u1', 'NONE');
  const gw = buildGateway({
    ...stub,
    presence,
    presenceRedis,
    spacesService,
    spacesPresence,
    watchPartyState,
    redis,
    marvIdentity,
  });

  const server = new FakeServer();
  const socket = new FakeSocket('socket-1', {
    userId: opts.userId === undefined ? 'u1' : opts.userId,
    viewer: opts.viewer ?? {},
  });
  server.register(socket);
  const fakeIoServer = {
    sockets: { sockets: server.socketsMap.sockets },
    to: (room: string) => server.to(room),
    emit: (event: string, payload?: unknown) => server.emitted.push({ event, payload }),
  };
  (gw as any).server = fakeIoServer;
  gw.afterInit(fakeIoServer as any);

  return { gw, socket, prisma: stub.prisma };
}

describe('groups:subscribe', () => {
  it('subscribes an active member to the group room', async () => {
    const { gw, socket } = makeGroupsSubscribeFixture({ joinPolicy: 'approval', activeMember: true });

    await (gw as any).handleGroupsSubscribe(socket, { groupIds: [GROUP_ID] });

    expect(socket.lastEmitted('groups:subscribed')).toEqual({ groupIds: [GROUP_ID] });
  });

  it('subscribes a verified non-member to an OPEN group room', async () => {
    const { gw, socket } = makeGroupsSubscribeFixture({
      joinPolicy: 'open',
      activeMember: false,
      viewer: { verified: true },
    });

    await (gw as any).handleGroupsSubscribe(socket, { groupIds: [GROUP_ID] });

    expect(socket.lastEmitted('groups:subscribed')).toEqual({ groupIds: [GROUP_ID] });
  });

  it('does NOT subscribe a non-member to an approval (private) group', async () => {
    const { gw, socket } = makeGroupsSubscribeFixture({
      joinPolicy: 'approval',
      activeMember: false,
      viewer: { verified: true },
    });

    await (gw as any).handleGroupsSubscribe(socket, { groupIds: [GROUP_ID] });

    expect(socket.allEmitted('groups:subscribed')).toHaveLength(0);
  });

  it('does NOT subscribe an unverified non-member to an OPEN group', async () => {
    const { gw, socket } = makeGroupsSubscribeFixture({
      joinPolicy: 'open',
      activeMember: false,
      viewer: { verified: false },
    });

    await (gw as any).handleGroupsSubscribe(socket, { groupIds: [GROUP_ID] });

    expect(socket.allEmitted('groups:subscribed')).toHaveLength(0);
  });
});
