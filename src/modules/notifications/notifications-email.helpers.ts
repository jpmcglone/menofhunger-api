import type { AvatarVideoDto } from "../../common/dto/avatar-video.dto";
import { EMAIL_DARK, escapeHtml } from "../email/templates/moh-email";

export function safeBaseUrl(raw: string | null): string {
  const base = (raw ?? '').trim() || 'https://menofhunger.com';
  return base.replace(/\/$/, '');
}

export function renderEmailAvatar(params: {
  profileUrl: string;
  avatarUrl: string | null; avatarVideo?: AvatarVideoDto | null;
  displayName: string;
  size?: number;
}): string {
  const { profileUrl, avatarUrl, displayName, size = 40 } = params;
  const initial = escapeHtml((displayName || '?')[0].toUpperCase());
  const inner = avatarUrl
    ? `<img src="${escapeHtml(avatarUrl)}" width="${size}" height="${size}" alt="${escapeHtml(displayName)}" style="width:${size}px;height:${size}px;border-radius:50%;display:block;object-fit:cover;" />`
    : `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${EMAIL_DARK.elevated};color:${EMAIL_DARK.text};font-size:${Math.round(size * 0.4)}px;font-weight:700;text-align:center;line-height:${size}px;">${initial}</div>`;
  return `<a href="${escapeHtml(profileUrl)}" style="display:inline-block;text-decoration:none;">${inner}</a>`;
}

const ET_ZONE = 'America/New_York';

export function easternYmd(d: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = Number(parts.find((p) => p.type === 'year')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'month')?.value ?? 1);
  const dd = Number(parts.find((p) => p.type === 'day')?.value ?? 1);
  return { y, m, d: dd };
}

export function easternYmdHm(d: Date): { y: number; m: number; d: number; hh: number; mm: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const y = Number(parts.find((p) => p.type === 'year')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'month')?.value ?? 1);
  const dd = Number(parts.find((p) => p.type === 'day')?.value ?? 1);
  // Some Intl implementations can emit "24" for midnight with 24-hour formatting.
  // Normalize so minute-of-day checks always treat midnight as 00:xx.
  const hhRaw = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const hh = Number.isFinite(hhRaw) ? ((hhRaw % 24) + 24) % 24 : 0;
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return { y, m, d: dd, hh, mm };
}

export function easternDayKey(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

export function easternUtcMsForLocal(params: { y: number; m: number; d: number; hh: number; mm: number }): number {
  for (let utcHour = 0; utcHour <= 23; utcHour++) {
    const cand = new Date(Date.UTC(params.y, params.m - 1, params.d, utcHour, params.mm, 0));
    const p = easternYmdHm(cand);
    if (p.y === params.y && p.m === params.m && p.d === params.d && p.hh === params.hh && p.mm === params.mm) {
      return cand.getTime();
    }
  }
  // Fallback: should never happen (8am ET always exists).
  return Date.now();
}

export function truncate(s: string, max: number): string {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}
