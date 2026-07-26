import { BadRequestException } from '@nestjs/common';

export const SOCIAL_NETWORKS = {
  x: {
    label: 'X',
    hosts: ['x.com', 'twitter.com'],
    profileBaseUrl: 'https://x.com',
    // X handles: 1–15 chars, letters/digits/underscores.
    pattern: /^[A-Za-z0-9_]{1,15}$/,
    validationMessage: 'X username can only contain letters, numbers, and underscores (max 15 characters).',
  },
  pickax: {
    label: 'Pickax',
    hosts: ['pickax.com'],
    profileBaseUrl: 'https://pickax.com',
    // Pickax handles: 1–30 chars, letters/digits/underscores/hyphens/dots (observed on site).
    pattern: /^[A-Za-z0-9_.\-]{1,30}$/,
    validationMessage: 'Pickax username can only contain letters, numbers, underscores, hyphens, and dots (max 30 characters).',
  },
} as const;

export type SocialNetwork = keyof typeof SOCIAL_NETWORKS;

/**
 * Normalise a user-supplied social handle for `network`.
 *
 * Accepts any of:
 *   "handle"
 *   "@handle"
 *   "x.com/handle"
 *   "https://x.com/handle"
 *   "https://twitter.com/handle"   (X alias)
 *
 * Returns the case-preserved handle string, or throws a user-facing
 * `BadRequestException` when the value cannot be cleaned up.
 */
export function normalizeSocialHandle(network: SocialNetwork, raw: string): string {
  const config = SOCIAL_NETWORKS[network];
  let s = (raw ?? '').trim();

  // Strip leading @.
  if (s.startsWith('@')) {
    s = s.slice(1).trim();
  }

  // If the user pasted a URL or a bare host/path, extract the last path segment.
  if (s.includes('/') || s.includes('.')) {
    // Prepend scheme so URL() can parse bare hostnames like "x.com/handle".
    const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    let parsed: URL;
    try {
      parsed = new URL(withScheme);
    } catch {
      throw new BadRequestException(`${config.label} username must be a valid username or profile URL.`);
    }

    // Verify the host belongs to a known domain for this network.
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const knownHost = (config.hosts as readonly string[]).some((h) => host === h || host.endsWith(`.${h}`));
    if (!knownHost) {
      // Allow bare handles that happen to contain a dot (e.g. Pickax allows them).
      if (!s.includes('/')) {
        // No slash → treat the whole thing as a handle (dots are valid in some networks).
        // Fall through to pattern validation below.
      } else {
        throw new BadRequestException(
          `${config.label} username must come from ${config.hosts.join(' or ')}.`,
        );
      }
    } else {
      // Extract last non-empty path segment as the handle.
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length === 0) {
        throw new BadRequestException(`${config.label} username is missing from that URL.`);
      }
      s = parts[parts.length - 1];
    }
  }

  if (!s) {
    throw new BadRequestException(`${config.label} username is required.`);
  }

  if (!config.pattern.test(s)) {
    throw new BadRequestException(config.validationMessage);
  }

  return s;
}
