import type { SpaceReactionDto } from '../dto';

export const ALLOWED_REACTIONS: SpaceReactionDto[] = [
  { id: 'heart',    emoji: '❤️', label: 'Love' },
  { id: 'thumbsup', emoji: '👍', label: 'Thumbs up' },
  { id: 'pray',     emoji: '🙏', label: 'Prayer' },
  { id: 'fire',     emoji: '🔥', label: 'Fire' },
  { id: 'cross',    emoji: '✝️', label: 'Cross' },
  { id: 'joy',      emoji: '😂', label: 'Haha' },
  { id: 'sad',      emoji: '😢', label: 'Sad' },
];

export function findReactionById(reactionId: string): SpaceReactionDto | null {
  const id = (reactionId ?? '').trim();
  if (!id) return null;
  return ALLOWED_REACTIONS.find((r) => r.id === id) ?? null;
}
