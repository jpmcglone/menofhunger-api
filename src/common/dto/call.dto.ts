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
  | 'already_in_call'
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
  error?: CallsAckErrorDto | null;
};

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

/** Relayed SDP / ICE between two current participants. Exactly one of description/candidate is set. */
export type RtcSignalPayloadDto = {
  callId: string;
  fromUserId: string;
  description?: RtcSessionDescriptionDto;
  candidate?: RtcIceCandidateDto;
};
