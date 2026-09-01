import type { MessageConversationType } from '@prisma/client';

/** Peer-to-peer mesh: every participant uploads to every other. 4 is the hard ceiling. */
export const CALL_CAPACITY_DIRECT = 2;
export const CALL_CAPACITY_GROUP = 4;

export function callCapacityFor(type: MessageConversationType): number {
  return type === 'direct' ? CALL_CAPACITY_DIRECT : CALL_CAPACITY_GROUP;
}

/** Unanswered direct call → "Missed call". */
export const CALL_RING_TIMEOUT_MS = 40_000;
/** Everyone left → keep the session so a reconnect can resume, then end it. */
export const CALL_EMPTY_GRACE_MS = 30_000;
/**
 * Socket dropped mid-call → keep the seat, then remove the participant. Returned to clients
 * as `reconnectGraceMs` so web and iOS give up at the same moment the server does. 30s covers
 * a Wi-Fi↔cellular handover plus an iOS app resume.
 */
export const CALL_PARTICIPANT_GRACE_MS = 30_000;

/**
 * Periodic liveness sweep (`CallsSweepCron`): re-checks every live session against presence's
 * socket registry and the timers' deadlines. Primary paths are event-driven; this is the
 * backstop for crashed processes and lost jobs.
 */
export const CALL_SWEEP_INTERVAL_MS = 15_000;
/** Extra headroom so the sweep never races a delayed job that is about to fire on time. */
export const CALL_SWEEP_SLACK_MS = 5_000;

/** Redis safety-net TTL. Timers and the sweep end calls long before this. */
export const CALL_SESSION_TTL_SECONDS = 12 * 60 * 60;

export function callRingTimeoutJobId(callId: string): string {
  return `call-ring-${callId}`;
}

export function callEmptyGraceJobId(callId: string): string {
  return `call-empty-${callId}`;
}

export function callParticipantGraceJobId(callId: string, userId: string): string {
  return `call-pgrace-${callId}-${userId}`;
}
