/**
 * Special mention keywords. They are not usernames, so signup and username changes must never
 * accept them (see users.utils.ts).
 */
export const BROADCAST_MENTIONS = ['everyone', 'here'] as const;
export type BroadcastMention = (typeof BROADCAST_MENTIONS)[number];

export function broadcastMentionsIn(usernames: string[]): { everyone: boolean; here: boolean } {
  const lower = new Set(usernames.map(name => name.toLowerCase()));
  return { everyone: lower.has('everyone'), here: lower.has('here') };
}
