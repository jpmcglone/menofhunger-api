import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { GroupChannelReferenceDto } from '../../common/dto/group-channel.dto';

/** Only channel messages interpret these tokens. They contain identity, never a private label. */
export const channelToken = (id: string) => `<#${id}>`;
const TOKEN = /<#([A-Za-z0-9_-]+)>/g;
const HANDLE = /(^|[^A-Za-z0-9_#/<])#([A-Za-z0-9][A-Za-z0-9-]{0,79})(?![A-Za-z0-9_-])/g;
type ReferenceChannel = {
  id: string; name: string; displayName: string | null; privacy: 'normal' | 'private';
  access: Array<{ userId: string }>;
};
export type ChannelReferenceCatalog = Map<string, ReferenceChannel>;

function handles(body: string) {
  const urls = [...body.matchAll(/https?:\/\/\S+/gi)].map(match => ({ start: match.index!, end: match.index! + match[0].length }));
  return [...body.matchAll(HANDLE)].filter(match => {
    const start = match.index! + match[1].length;
    return !urls.some(url => start >= url.start && start < url.end);
  });
}

/** Batch once for HTTP pages or a realtime audience. Private access is explicit, even for leaders. */
export async function channelReferenceCatalog(
  db: Prisma.TransactionClient,
  groupId: string,
  bodies: string[],
  userIds: string[],
): Promise<ChannelReferenceCatalog> {
  const ids = new Set(bodies.flatMap(body => [...body.matchAll(TOKEN)].map(match => match[1])));
  const names = new Set(bodies.flatMap(body => handles(body).map(match => match[2].toLowerCase())));
  if (!ids.size && !names.size) return new Map();
  const rows = await db.groupChannel.findMany({
    where: { groupId, OR: [
      ...(ids.size ? [{ id: { in: [...ids] } }] : []),
      ...(names.size ? [{ name: { in: [...names] } }] : []),
    ] },
    select: { id: true, name: true, displayName: true, privacy: true, access: { where: { userId: { in: userIds } }, select: { userId: true } } },
  });
  return new Map(rows.map(row => [row.id, row]));
}

/** Legacy #handles are resolved only within this group's catalog, never through a global lookup. */
function tokenizeHandles(body: string, catalog: ChannelReferenceCatalog) {
  const byName = new Map([...catalog.values()].map(channel => [channel.name.toLowerCase(), channel]));
  let next = body;
  for (const match of handles(body).reverse()) {
    const channel = byName.get(match[2].toLowerCase());
    if (!channel) continue;
    const start = match.index! + match[1].length;
    next = next.slice(0, start) + channelToken(channel.id) + next.slice(start + match[2].length + 1);
  }
  return next;
}

const readable = (channel: ReferenceChannel, userId: string) => channel.privacy === 'normal' || channel.access.some(access => access.userId === userId);

/** Run inside the existing group lifecycle lock. New explicit tokens require current target access. */
export async function canonicalChannelBody(db: Prisma.TransactionClient, userId: string, groupId: string, body: string, previousBody?: string) {
  const explicit = [...body.matchAll(TOKEN)].map(match => match[1]);
  const previous = new Set([...(previousBody ?? '').matchAll(TOKEN)].map(match => match[1]));
  const catalog = await channelReferenceCatalog(db, groupId, [body], [userId]);
  for (const id of explicit) {
    const channel = catalog.get(id);
    if ((!channel || !readable(channel, userId)) && !previous.has(id)) throw new BadRequestException('That channel reference is unavailable.');
  }
  return tokenizeHandles(body, catalog);
}

/** The body is safe to return unchanged: every recognized handle has become an ID-only token. */
export function presentChannelBody(body: string, userId: string, catalog: ChannelReferenceCatalog) {
  const canonical = tokenizeHandles(body, catalog);
  const channelReferences: GroupChannelReferenceDto[] = [];
  const seen = new Set<string>();
  for (const match of canonical.matchAll(TOKEN)) {
    const token = match[0];
    if (seen.has(token)) continue;
    seen.add(token);
    const channel = catalog.get(match[1]);
    const accessible = Boolean(channel && readable(channel, userId));
    channelReferences.push({
      token, channelId: accessible ? channel!.id : null, name: accessible ? channel!.name : null,
      displayName: accessible ? channel!.displayName : null, privacy: channel?.privacy ?? 'private', accessible,
    });
  }
  return { body: canonical, channelReferences };
}

/** Preview copy has no private labels or raw IDs, including on authorized members' lock screens. */
export function channelReferencePreview(body: string, catalog: ChannelReferenceCatalog) {
  return tokenizeHandles(body, catalog).replace(TOKEN, (_token, id: string) => {
    const channel = catalog.get(id);
    return channel?.privacy === 'normal' ? `#${channel.displayName ?? channel.name}` : 'Private';
  });
}
