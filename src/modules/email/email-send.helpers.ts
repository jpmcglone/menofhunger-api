export type GreetingTone = 'hey' | 'morning';

export function getRecipientEmail(email: string | null | undefined): string | null {
  const to = String(email ?? '').trim();
  return to.length > 0 ? to : null;
}

export function getVerifiedRecipientEmail(user: {
  email: string | null | undefined;
  emailVerifiedAt: Date | null | undefined;
}): string | null {
  if (!user.emailVerifiedAt) return null;
  return getRecipientEmail(user.email);
}

export function preferredDisplayName(params: {
  name: string | null | undefined;
  username: string | null | undefined;
}): string | null {
  const name = String(params.name ?? '').trim();
  if (name) return name;
  const username = String(params.username ?? '').trim();
  return username || null;
}

/** First word of `name`, else `username`, else `"there"` (so "Hey {{firstName}}," never reads "Hey ,"). */
export function firstNameFrom(params: {
  name: string | null | undefined;
  username: string | null | undefined;
}): string {
  const name = String(params.name ?? '').trim();
  if (name) {
    const first = name.split(/\s+/)[0];
    if (first) return first;
  }
  const username = String(params.username ?? '').trim();
  return username || 'there';
}

export function buildGreeting(params: {
  name: string | null | undefined;
  username: string | null | undefined;
  tone?: GreetingTone;
}): string {
  const tone = params.tone ?? 'hey';
  const displayName = preferredDisplayName(params);
  if (tone === 'morning') return displayName ? `Good morning ${displayName},` : `Good morning,`;
  return displayName ? `Hey ${displayName},` : `Hey,`;
}
