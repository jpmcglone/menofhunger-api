import { BadRequestException, ForbiddenException } from '@nestjs/common';

export const DEFAULT_CHANNELS = ['announcements', 'general', 'random'] as const;
export const isChannelLeader = (role: string) => role === 'owner' || role === 'moderator';

export function channelCapabilities(channel: { archivedAt: Date | null; defaultPurpose: string | null; privacy: string }, role: string) {
  const leader = isChannelLeader(role);
  const writable = !channel.archivedAt;
  return {
    canSend: writable && (channel.defaultPurpose !== 'announcements' || leader),
    canReact: writable,
    canManage: leader,
    canInvite: leader && writable && channel.privacy === 'private',
    canModerate: leader && writable,
    canArchive: leader && !channel.defaultPurpose,
    canRename: leader && !channel.defaultPurpose,
  };
}

export function assertChannelSend(channel: { archivedAt: Date | null; defaultPurpose: string | null; privacy: string }, role: string) {
  if (!channelCapabilities(channel, role).canSend) throw new ForbiddenException('You cannot post in this channel.');
}

export function assertChannelUpdate(channel: { defaultPurpose: string | null; name: string; displayName?: string | null }, patch: { name?: string; displayName?: string | null; archived?: boolean }) {
  const renamed = (patch.name !== undefined && patch.name !== channel.name)
    || (patch.displayName !== undefined && patch.displayName !== (channel.displayName ?? null));
  if (channel.defaultPurpose && (renamed || patch.archived === true)) {
    throw new BadRequestException('Default channels cannot be renamed or archived.');
  }
}

export function normalizeChannelName(value: string) {
  const name = value.trim().replace(/^#/, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name)) throw new BadRequestException('Use letters, numbers and hyphens for the channel name.');
  return name;
}

/** Free-form title; null or blank falls back to the handle. */
export function normalizeChannelDisplayName(value: string | null | undefined): string | null {
  const title = value?.replace(/\s+/g, ' ').trim();
  if (!title) return null;
  if (title.length > 80 || /[\p{Cc}\p{Cf}]/u.test(title)) throw new BadRequestException('Use up to 80 characters for the channel display name.');
  return title;
}

/** A handle suggestion for a title, used when only a display name is supplied. */
export function slugifyChannelName(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/** One emoji (including flags, skin tones and ZWJ sequences) or null for the default "#". */
export function normalizeChannelIcon(value: string | null | undefined): string | null {
  const icon = value?.trim();
  if (!icon) return null;
  const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(icon)];
  if (graphemes.length !== 1 || !/^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})/u.test(icon)) {
    throw new BadRequestException('Choose a single emoji for the channel icon.');
  }
  return icon;
}
