import * as crypto from 'node:crypto';
import { OTP_CODE_LENGTH } from './auth.constants';

export function normalizePhone(input: string) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Phone is required');

  // Keep leading '+' if present, otherwise strip non-digits.
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  const normalized = hasPlus ? `+${digits}` : digits;

  // Best-effort normalization:
  // - If already E.164-ish (+ + 8-15 digits), accept
  // - If 10 digits, assume US and prefix +1
  // - If 8-15 digits, prefix +
  if (/^\+\d{8,15}$/.test(normalized)) return normalized;
  if (/^\d{10}$/.test(normalized)) return `+1${normalized}`;
  if (/^\d{8,15}$/.test(normalized)) return `+${normalized}`;

  throw new Error('Invalid phone number format');
}

export function generateNumericCode(length = OTP_CODE_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i++) out += crypto.randomInt(0, 10).toString();
  return out;
}

export function hmacSha256Hex(secret: string, value: string) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function randomSessionToken() {
  // Node 20 supports base64url
  return crypto.randomBytes(32).toString('base64url');
}

