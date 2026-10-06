export type UsernameValidationResult =
  | { ok: true; username: string; usernameLower: string }
  | { ok: false; error: string };

/** Mention keywords: refused for everyone, including administrators. */
export const MENTION_KEYWORD_USERNAMES = ['everyone', 'here', 'channel', 'all', 'everybody', 'anyone', 'online'];
/** Names that could pass as the company or its tooling. Members cannot take them; administrators can assign them. */
export const RESERVED_USERNAMES = [
  'admin', 'admins', 'administrator', 'mod', 'mods', 'moderator', 'moderators', 'staff', 'support', 'help', 'system',
  'official', 'menofhunger', 'moh', 'root', 'security', 'team', 'null', 'undefined', 'api', 'www', 'mail', 'noreply',
];

export function isReservedUsername(lower: string, opts?: { allowReserved?: boolean }): boolean {
  return MENTION_KEYWORD_USERNAMES.includes(lower) || (!opts?.allowReserved && RESERVED_USERNAMES.includes(lower));
}

export function validateUsername(input: string, opts?: { minLen?: number; allowReserved?: boolean }): UsernameValidationResult {
  const raw = input.trim();
  const minLen = opts?.minLen ?? 6;
  if (!raw) return { ok: false, error: 'Username is required.' };
  if (raw.length < minLen) return { ok: false, error: `Username must be at least ${minLen} characters.` };
  if (raw.length > 15) return { ok: false, error: 'Username must be 15 characters or fewer.' };

  // Must start with a letter. Allowed chars are letters, numbers, underscore.
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(raw)) {
    return {
      ok: false,
      error: 'Usernames must start with a letter and contain only letters, numbers, and underscores.',
    };
  }

  if (isReservedUsername(raw.toLowerCase(), opts)) return { ok: false, error: 'That username is reserved. Try another.' };

  return { ok: true, username: raw, usernameLower: raw.toLowerCase() };
}

