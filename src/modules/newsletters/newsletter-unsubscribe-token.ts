import { createHmac } from 'node:crypto';

const PURPOSE = 'nl';
const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function issueNewsletterUnsubscribeToken(params: {
  userId: string;
  secret: string;
  now?: Date;
  ttlMs?: number;
}): string {
  const exp = Math.floor(((params.now ?? new Date()).getTime() + (params.ttlMs ?? DEFAULT_TTL_MS)) / 1000);
  const payload = `${PURPOSE}.${params.userId}.${exp}`;
  const sig = sign(payload, params.secret);
  return Buffer.from(`${payload}.${sig}`, 'utf8').toString('base64url');
}

export function verifyNewsletterUnsubscribeToken(params: {
  token: string;
  secret: string;
  now?: Date;
}): { userId: string } | null {
  const raw = String(params.token ?? '').trim();
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split('.');
  if (parts.length !== 4) return null;
  const [purpose, userId, expRaw, sig] = parts;
  if (purpose !== PURPOSE || !userId || !expRaw || !sig) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp * 1000 <= (params.now ?? new Date()).getTime()) return null;
  const payload = `${purpose}.${userId}.${expRaw}`;
  if (!safeEqual(sig, sign(payload, params.secret))) return null;
  return { userId };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
