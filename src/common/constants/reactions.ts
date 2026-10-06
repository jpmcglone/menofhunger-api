import type { SpaceReactionDto } from '../dto';

export const ALLOWED_REACTIONS: SpaceReactionDto[] = [
  { id: 'heart',    emoji: '❤️', label: 'Love' },
  { id: 'thumbsup', emoji: '👍', label: 'Thumbs up' },
  { id: 'strong',   emoji: '💪', label: 'Strong' },
  { id: 'pray',     emoji: '🙏', label: 'Prayer' },
  { id: 'fire',     emoji: '🔥', label: 'Fire' },
  { id: 'cross',    emoji: '✝️', label: 'Cross' },
  { id: 'joy',      emoji: '😂', label: 'Haha' },
  { id: 'sad',      emoji: '😢', label: 'Sad' },
  { id: 'check',    emoji: '✅', label: 'Done' },
  { id: 'eyes',     emoji: '👀', label: 'Looking' },
  { id: 'raised_hands', emoji: '🙌', label: 'Celebrate' },
  { id: 'clap',     emoji: '👏', label: 'Applause' },
  { id: 'hundred',  emoji: '💯', label: 'One hundred' },
  { id: 'fist',     emoji: '👊', label: 'Fist bump' },
  { id: 'think',    emoji: '🤔', label: 'Thinking' },
  { id: 'laugh',    emoji: '🤣', label: 'Laughing' },
  { id: 'party',    emoji: '🎉', label: 'Party' },
  { id: 'wave',     emoji: '👋', label: 'Wave' },
];

export function findReactionById(reactionId: string): SpaceReactionDto | null {
  const id = (reactionId ?? '').trim();
  if (!id) return null;
  return ALLOWED_REACTIONS.find((r) => r.id === id) ?? null;
}
