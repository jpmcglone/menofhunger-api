/** Default identity name from create: `{username}'s Space`. */
export function isDefaultSpaceTitle(title: string): boolean {
  return /^.+'s space$/i.test(title.trim());
}

/**
 * Event name for notifications/emails/display.
 * Owner title wins when it's a real name; otherwise YouTube/radio playback.
 */
export function resolveSpaceEventTitle(input: {
  title: string;
  playbackTitle?: string | null;
}): string {
  const stored = input.title.trim();
  const playing = (input.playbackTitle ?? '').trim();
  if (stored && !isDefaultSpaceTitle(stored)) return stored;
  return playing || stored || 'Space';
}
