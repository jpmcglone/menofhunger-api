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
/** Socket dropped mid-call → keep the seat, then remove the participant. */
export const CALL_PARTICIPANT_GRACE_MS = 20_000;

/** Redis safety-net TTL. Timers end calls long before this; it only catches lost jobs. */
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
