import type { UserListDto } from './user.dto';

/**
 * DM voice/video calling (browser-to-browser WebRTC).
 *
 * The API never touches media. These DTOs describe the ephemeral call session the
 * server keeps in Redis for signaling/authorization, plus the tiny summary that is
 * persisted on the `kind: 'call'` message row in the conversation timeline.
 */

export type CallType = 'audio' | 'video';

/**
 * ringing: direct call, callee has not answered yet (caller is the only participant).
 * active:  at least one participant is connected.
 * empty:   everyone left; the session lingers ~30s so a reconnect can resume it.
 * ended:   terminal. The Redis record is gone; only the timeline message remains.
 */
export type CallStatus = 'ringing' | 'active' | 'empty' | 'ended';

export type CallParticipantConnectionState = 'connected' | 'reconnecting';

export type CallParticipantDto = {
  userId: string;
  joinedAt: string;
  micEnabled: boolean;
  cameraEnabled: boolean;
  connectionState: CallParticipantConnectionState;
  /** Web only: the participant's outgoing video track is a screen capture (render contain-fit, unmirrored). */
  screenSharing?: boolean;
  /** Raised hand. Clients only show this in calls with more than two people. */
  handRaised?: boolean;
};

export type CallSessionDto = {
  id: string;
  conversationId: string;
  type: CallType;
  status: CallStatus;
  startedByUserId: string;
  /** True when a site admin started the call; unverified members may only join those. */
  startedByAdmin: boolean;
  startedAt: string;
  endedAt: string | null;
  /** 2 for direct conversations, 4 for groups. Independent of conversation membership. */
  capacity: number;
  /** The `kind: 'call'` message row that tracks this call in the timeline. */
  messageId: string | null;
  /** Current participants only (connected or reconnecting). */
  participants: CallParticipantDto[];
};

/**
 * Terminal or in-progress outcome recorded on the timeline row.
 * started/active mean the call is live; the rest are terminal.
 */
export type MessageCallOutcome = 'started' | 'active' | 'ended' | 'missed' | 'declined' | 'cancelled';

export type MessageCallDto = {
  callId: string;
  type: CallType;
  outcome: MessageCallOutcome;
  durationSeconds: number | null;
  peakParticipantCount: number;
};

export type RtcIceServerDto = {
  urls: string[];
  username?: string;
  credential?: string;
};

export type RtcSessionDescriptionDto = {
  type: string;
  sdp?: string;
};

export type RtcIceCandidateDto = {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
};

export type CallsAckErrorCode =
  | 'not_authenticated'
  | 'not_member'
  | 'not_allowed_to_start'
  | 'callee_not_verified'
  | 'callee_unavailable'
  | 'conversation_not_accepted'
  | 'not_verified'
  | 'call_not_found'
  | 'call_ended'
  | 'call_full'
  | 'invalid_payload';

export type CallsAckErrorDto = {
  code: CallsAckErrorCode;
  message: string;
};

/** Socket.IO ack for `calls:start` / `calls:join` / `calls:leave` / `calls:decline`. */
export type CallsAckDto = {
  call: CallSessionDto | null;
  /** Present on successful start/join so the client can build its RTCPeerConnections. */
  iceServers?: RtcIceServerDto[];
  /**
   * Present on successful start/join. How long the server keeps a participant's seat after
   * their socket drops. Clients keep retrying signaling/ICE for exactly this long, then give up.
   */
  reconnectGraceMs?: number;
  error?: CallsAckErrorDto | null;
};

/**
 * PushKit (VoIP) payload for a direct-call ring on iOS. Must be enough to report the call
 * to CallKit synchronously with zero network; the socket supplies truth after wake.
 */
export type CallVoipPushPayloadDto = {
  callId: string;
  conversationId: string;
  type: CallType;
  caller: UserListDto;
  /**
   * Flat CallKit title. Name, else username. iOS must report this synchronously from the
   * VoIP push — nested `caller` decode must not be the only way to get a person name.
   */
  callerName: string;
  callerUsername?: string | null;
  callerAvatarUrl?: string | null;
  /** ISO time after which the phone stops ringing locally (mirrors the server ring timeout). */
  expiresAt: string;
};

/** Lock-screen / Recents title for a direct ring. Never the app name. */
export function callKitCallerName(caller: Pick<UserListDto, 'name' | 'username'>): string {
  const name = caller.name?.trim() ?? '';
  if (name) return name;
  const username = caller.username?.trim() ?? '';
  if (username) return username;
  return 'Incoming call';
}

// ─── Realtime payloads ────────────────────────────────────────────────────────

/** Direct-call ring, sent only to the callee. */
export type CallsIncomingPayloadDto = {
  call: CallSessionDto;
  caller: UserListDto;
};

/** Single patch-shaped event for every lifecycle/participant change. */
export type CallsUpdatedPayloadDto = {
  conversationId: string;
  call: CallSessionDto;
};

/**
 * A member may hold exactly one call seat. When another tab or device of theirs joins (the
 * same call or a different one), this goes to every socket of that user; the socket whose id
 * matches `socketId` was displaced and must tear down locally WITHOUT sending `calls:leave`,
 * since the seat now belongs to the newcomer.
 */
export type CallsSeatTakenPayloadDto = {
  callId: string;
  /** The displaced socket. */
  socketId: string;
};

/**
 * Presence: `userId` entered or left a call (any type). Sent to online-feed listeners and
 * presence subscribers, same audience as `presence:status-updated`.
 */
export type PresenceCallChangedPayloadDto = {
  userId: string;
  inCall: boolean;
};

/** Relayed SDP / ICE between two current participants. Exactly one of description/candidate is set. */
export type RtcSignalPayloadDto = {
  callId: string;
  fromUserId: string;
  description?: RtcSessionDescriptionDto;
  candidate?: RtcIceCandidateDto;
};
