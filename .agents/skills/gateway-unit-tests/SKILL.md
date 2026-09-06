---
name: gateway-unit-tests
description: Write unit tests for PresenceGateway (and other NestJS WebSocket gateways) using the FakeSocket/FakeServer pattern — no real process or Redis required. Use when adding or modifying PresenceGateway handler tests, writing tests for spaces:join/leave/watchPartyControl/announceMode, or when asked to test WebSocket gateway logic.
---

# Gateway Unit Tests (FakeSocket/FakeServer pattern)

Testing NestJS gateways directly (invoking handlers with mock sockets) is faster and more reliable than booting a real server. The existing spec lives at `src/modules/presence/presence.gateway.spec.ts`.

## Core infrastructure

```typescript
class FakeSocket {
  readonly id: string
  readonly emitted: { event: string; payload: unknown }[] = []
  readonly data: Record<string, unknown> = {}

  emit(event: string, payload?: unknown) { this.emitted.push({ event, payload ?? null }); return this }
  join(room: string) { /* track rooms if needed */ }
  leave(room: string) {}

  lastEmitted(event: string) {
    const all = this.emitted.filter(e => e.event === event)
    return all[all.length - 1]?.payload
  }
}

class FakeServer {
  private readonly sockets = new Map<string, FakeSocket>()
  private readonly rooms = new Map<string, Set<string>>()
  readonly emitted: { event: string; payload: unknown }[] = []

  register(socket: FakeSocket) { this.sockets.set(socket.id, socket) }

  // Gateway accesses server.sockets.sockets.get(id)
  get asIoServer() {
    return {
      sockets: { sockets: this.sockets },
      to: (room: string) => ({
        emit: (event: string, payload?: unknown) => {
          this.emitted.push({ event, payload })
          for (const id of this.rooms.get(room) ?? [])
            this.sockets.get(id)?.emit(event, payload)
        },
      }),
      emit: (event: string, payload?: unknown) => this.emitted.push({ event, payload }),
    }
  }

  joinRoom(socketId: string, room: string) {
    if (!this.rooms.has(room)) this.rooms.set(room, new Set())
    this.rooms.get(room)!.add(socketId)
  }
}
```

## Wiring the gateway

```typescript
const gw = new PresenceGateway(appConfig, auth, presence, presenceRedis, realtime,
  follows, messages, radio, radioChat, spaces, spacesPresence, spacesChat,
  watchPartyState, prisma, redis)

const server = new FakeServer()
;(gw as any).server = server.asIoServer
gw.afterInit(server.asIoServer as any)
```

## Mock factories

- `makePresenceService()` — include `getSubscribers: jest.fn().mockReturnValue(new Set())` and `getOnlineFeedListeners: jest.fn().mockReturnValue(new Set())`
- `makeSpacesPresenceService()` — include `getMembersForSpace: jest.fn().mockReturnValue({ userIds: [], pausedUserIds: [], mutedUserIds: [] })`
- `makeSpacesService(ownerId, mode)` — `getOwnerIdForSpace`, `getSpaceMode`, `isSpaceActive`, `activateSpaceByOwnerId`

## Invoking handlers

```typescript
// Always register the socket and join it to the space room before calling join handlers
server.register(ownerSocket)
server.joinRoom(ownerSocket.id, `space:${SPACE_ID}`)
await (gw as any).handleSpacesJoin(ownerSocket, { spaceId: SPACE_ID })

// Disconnect
spacesPresence.onDisconnect.mockReturnValueOnce({ userId: OWNER_ID, spaceId: SPACE_ID, wasActive: true })
;(ownerSocket.data as any).ownerSpaceId = SPACE_ID
gw.handleDisconnect(ownerSocket as any)
```

## Key assertions

```typescript
// Socket received an event
ownerSocket.lastEmitted('spaces:watchPartyOwnerReplaced')  // → { spaceId }

// Room received a broadcast
server.emitted.filter(e => e.event === 'spaces:watchPartyState')

// In-memory state
watchPartyState.getState(SPACE_ID)  // use the real WatchPartyStateService, not a mock
```

Always use the **real `WatchPartyStateService`** (with a mock Redis) rather than mocking it — that lets you assert on actual stored state rather than call counts.
