export type UsernameValidationResult =
  | { ok: true; username: string; usernameLower: string }
  | { ok: false; error: string };

export function validateUsername(input: string): UsernameValidationResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Username is required.' };
  if (raw.length < 6) return { ok: false, error: 'Username must be at least 6 characters.' };
  if (raw.length > 15) return { ok: false, error: 'Username must be 15 characters or fewer.' };

  // Must start with a letter. Allowed chars are letters, numbers, underscore.
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(raw)) {
    return {
      ok: false,
      error: 'Usernames must start with a letter and contain only letters, numbers, and underscores.',
    };
  }

  return { ok: true, username: raw, usernameLower: raw.toLowerCase() };
}

