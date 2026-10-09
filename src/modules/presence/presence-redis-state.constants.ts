

export type PresenceEvent =
  | { type: 'online'; userId: string; instanceId: string }
  | { type: 'offline'; userId: string; instanceId: string }
  | { type: 'idle'; userId: string; instanceId: string }
  | { type: 'active'; userId: string; instanceId: string }
  | { type: 'platformsChanged'; userId: string; instanceId: string; platforms: string[] }
  | { type: 'emitToUser'; userId: string; instanceId: string; event: string; payload: unknown }
  | { type: 'emitToRoom'; userId: string; instanceId: string; room: string; event: string; payload: unknown }
  | { type: 'broadcast'; instanceId: string; event: string; payload: unknown }
  | { type: 'userStatusChanged'; userId: string; instanceId: string; event: string; payload: unknown }
  | { type: 'spacesLobbyCounts'; instanceId: string; countsBySpaceId: Record<string, number> }
  | {
      type: 'userSpaceChanged';
      userId: string;
      instanceId: string;
      spaceId: string | null;
      previousSpaceId?: string;
    }
  | { type: 'anonymousCount'; instanceId: string; anonymousOnline: number };

export const INSTANCE_HEARTBEAT_MS = 20_000;
export const INSTANCE_HEARTBEAT_TTL_SECONDS = 60;
