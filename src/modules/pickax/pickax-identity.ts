import { createHmac } from 'node:crypto';
import { normalizeSocialHandle } from '../users/social-handles';

export type PickaxTokenIdentity = {
  /** Handle asserted by the token, when present. */
  handle: string | null;
  /** Numeric Pickax account id asserted by the token, when present. */
  userId: string | null;
};

const HANDLE_CLAIMS = ['username', 'userName', 'handle', 'preferred_username', 'screenName'] as const;
const ID_CLAIMS = ['userId', 'user_id', 'uid', 'sub', 'id', 'accountId'] as const;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Stateless proof-of-ownership code for accounts whose token names no identity. The member
 * pastes it into their Pickax bio; only the account owner can, so finding it on the public
 * profile proves ownership. Bound to our user and the handle, so it cannot be reused.
 */
export function profileVerificationCode(userId: string, handle: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(`pickax-profile:${userId}:${handle.toLowerCase()}`).digest('hex');
  return `moh-verify-${digest.slice(0, 10)}`;
}

/** Claim names present in the token (names only), for diagnostics. */
export function readTokenClaimKeys(accessToken: string): string[] | null {
  const claims = decodeJwtPayload(accessToken);
  return claims ? Object.keys(claims) : null;
}

/** Reads the identity Pickax itself put in the access token. Never trusts client input. */
export function readTokenIdentity(accessToken: string): PickaxTokenIdentity {
  const claims = decodeJwtPayload(accessToken);
  if (!claims) return { handle: null, userId: null };

  let handle: string | null = null;
  for (const key of HANDLE_CLAIMS) {
    const v = claims[key];
    if (typeof v !== 'string' || !v.trim()) continue;
    try {
      handle = normalizeSocialHandle('pickax', v);
      break;
    } catch {
      // Not a usable handle; try the next claim.
    }
  }

  let userId: string | null = null;
  for (const key of ID_CLAIMS) {
    const v = claims[key];
    const raw = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
    const m = raw.match(/^(?:user[-_:])?(\d{1,12})$/i);
    if (m) {
      userId = m[1];
      break;
    }
  }
  return { handle, userId };
}

/**
 * True when public profile content demonstrably belongs to this account.
 * With an id we require Pickax's avatar/asset path for that id; without one the page must
 * name the handle. Anything else is rejected.
 */
export function profileMatchesIdentity(pageText: string, identity: { handle: string; userId: string | null }): boolean {
  const text = pageText ?? '';
  if (!text.trim()) return false;
  if (identity.userId) {
    return new RegExp(`img\\.pickax\\.com/user-${identity.userId}(?:/|\\b)`, 'i').test(text);
  }
  const escaped = identity.handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_.-])@${escaped}(?![A-Za-z0-9_.-])`, 'i').test(text);
}

/** Public profile renderings (direct page, then a readable-text proxy for client-rendered pages). */
export async function fetchPickaxProfileTexts(handle: string): Promise<string[]> {
  const url = `https://pickax.com/${encodeURIComponent(handle)}`;
  const texts: string[] = [];
  for (const source of [url, `https://r.jina.ai/${url}`]) {
    try {
      const res = await fetch(source, {
        headers: { 'User-Agent': 'MenOfHunger/1.0 (+https://menofhunger.com)' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.trim()) texts.push(text);
    } catch {
      // Try the next source.
    }
  }
  return texts;
}
