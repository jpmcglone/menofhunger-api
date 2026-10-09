import { ChannelMarvScopeService } from './channel-marv-scope.service';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ChannelAccessService } from './channel-access.service';
import { ChannelAttentionService } from './channel-attention.service';
import { makeChannelMessages } from './channel-messages.testing';
import { ChannelsService } from './channels.service';
import { provisionDefaultChannels } from './channel-provisioning';
import { prepareChannelDeparture } from './channel-lifecycle';
import { transferGroupOwnership } from '../groups/group-ownership';

// Never uses DATABASE_URL. Only the disposable runner's named loopback database is allowed.
const url = process.env.MOH_CHANNEL_FIXTURE_DATABASE_URL;
const enabled = url && new URL(url).hostname === '127.0.0.1' && new URL(url).pathname === '/moh_channel_fixture';
(enabled ? describe : describe.skip)('channels on an isolated PostgreSQL database', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://invalid/never-connect' } } });
  const config: any = { groupChannels: () => ({ enabled: true, groupIds: [] }), r2: () => null };
  const realtime: any = { emitGroupChannelMessages: jest.fn(), emitGroupChannelChanged: jest.fn(), emitGroupChannelViewer: jest.fn() };
  const effects: any = { dispatch: jest.fn() };
  const access = new ChannelAccessService(db as any, config);
  const channels = new ChannelsService(db as any, access, realtime, effects, config);
  const attention = new ChannelAttentionService(db as any, access, channels, effects, { onlineUserIds: async () => [] } as any);
  const { reader, writer: messages } = makeChannelMessages({ prisma: db as any, access, channels, attention, config, realtime, media: {} as any, effects });
  let group: string, owner: string, member: string, moderator: string, general: string, announcements: string;
  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    [owner, member, moderator] = await Promise.all(['owner', 'member', 'moderator'].map(async role => (await db.user.create({ data: { username: `${role}_${suffix}`, verifiedStatus: 'manual' } })).id));
    const created = await db.communityGroup.create({ data: { slug: `channel-fixture-${suffix}`, name: 'Synthetic channel group', description: 'Disposable test data', createdByUserId: owner, members: { create: [{ userId: owner, role: 'owner', status: 'active' }, { userId: member, role: 'member', status: 'active' }, { userId: moderator, role: 'moderator', status: 'active' }] } } });
    group = created.id;
    await db.$transaction(tx => provisionDefaultChannels(tx, group, owner));
    const defaults = await channels.list(owner, group);
    general = defaults.find(row => row.defaultPurpose === 'general')!.id;
    announcements = defaults.find(row => row.defaultPurpose === 'announcements')!.id;
    jest.clearAllMocks();
  });
  afterAll(() => db.$disconnect());
  const send = (user: string, channel: string, body: string, root?: string, request = randomUUID()) => messages.send(user, group, channel, { body, threadRootId: root, clientRequestId: request });

  it('backfills once, creates no Chat participants and protects the default channels', async () => {
    await db.$transaction(tx => provisionDefaultChannels(tx, group, owner));
    const rows = await channels.list(owner, group);
    expect(rows.map(row => row.name)).toEqual(['announcements', 'general', 'random']);
    expect(await db.messageParticipant.count({ where: { conversation: { groupChannel: { groupId: group } } } })).toBe(0);
    await expect(channels.update(owner, group, general, { archived: true })).rejects.toThrow('Default');
    await expect(channels.update(owner, group, general, { name: 'changed' })).rejects.toThrow('Default');
  });
  it('persists a custom channel icon for every member and resets to the default', async () => {
    expect(await channels.update(owner, group, general, { icon: '🔥' })).toMatchObject({ icon: '🔥' });
    expect((await channels.list(member, group)).find(row => row.id === general)).toMatchObject({ icon: '🔥' });
    await expect(channels.update(member, group, general, { icon: '💬' })).rejects.toThrow('Only group leaders');
    await expect(channels.update(owner, group, general, { icon: 'general' })).rejects.toThrow('single emoji');
    expect(await channels.update(owner, group, general, { icon: null })).toMatchObject({ icon: null });
  });
  it('keeps the display name independent from the unique handle', async () => {
    const made = await channels.create(owner, group, { name: 'fitness', displayName: 'Morning Workout 💪', privacy: 'normal' });
    expect(made).toMatchObject({ name: 'fitness', displayName: 'Morning Workout 💪' });
    const derived = await channels.create(owner, group, { displayName: 'Book Club!', privacy: 'normal' });
    expect(derived).toMatchObject({ name: 'book-club', displayName: 'Book Club!' });
    expect(await channels.update(owner, group, made.id, { displayName: 'Gym Rats' })).toMatchObject({ name: 'fitness', displayName: 'Gym Rats' });
    expect(await channels.update(owner, group, made.id, { displayName: null })).toMatchObject({ name: 'fitness', displayName: null });
    await expect(channels.create(owner, group, { name: 'fitness', displayName: 'Other', privacy: 'normal' })).rejects.toThrow('already in use');
  });
  it('rejects pending membership, unverified accounts and uninvited leadership before private reads', async () => {
    const privateChannel = await channels.create(owner, group, { name: 'leaders', privacy: 'private' });
    await send(owner, privateChannel.id, 'Private retained history');
    expect((await channels.list(moderator, group)).map(row => row.id)).not.toContain(privateChannel.id);
    await expect(reader.search(moderator, group, { q: 'Private', channelId: privateChannel.id })).rejects.toThrow('unavailable');
    expect((await reader.search(moderator, group, { q: 'Private retained' })).messages).toHaveLength(0);
    expect((await reader.search(owner, group, { q: 'Private retained' })).messages).toMatchObject([{ channelId: privateChannel.id }]);
    await expect(channels.details(moderator, group, privateChannel.id)).rejects.toThrow('unavailable');
    await db.communityGroupMember.update({ where: { groupId_userId: { groupId: group, userId: member } }, data: { status: 'pending' } });
    await expect(reader.list(member, group, general, {})).rejects.toThrow('unavailable');
    await db.user.update({ where: { id: moderator }, data: { verifiedStatus: 'none' } });
    await expect(channels.list(moderator, group)).rejects.toThrow('unavailable');
  });
  it('deduplicates concurrent sends and personal reasons, and acknowledges exact content', async () => {
    const name = (await db.user.findUniqueOrThrow({ where: { id: member } })).username;
    const root = await send(member, general, 'Root');
    const request = randomUUID();
    const [first, retry] = await Promise.all([send(owner, general, `@${name} Reply`, root.id, request), send(owner, general, `@${name} Reply`, root.id, request)]);
    expect(retry.id).toBe(first.id);
    expect(await access.personalCount(member, group)).toBe(1);
    expect(await access.hasUnread(member, group)).toBe(true);
    expect(await access.hasUnread(owner, group)).toBe(true);
    const row = await db.groupChannelAttention.findUniqueOrThrow({ where: { messageId_userId: { messageId: first.id, userId: member } } });
    expect(row).toMatchObject({ mentioned: true, followedReply: true });
    await attention.acknowledge(member, group, general, { messageIds: [root.id] });
    expect(await access.personalCount(member, group)).toBe(1);
    await attention.acknowledge(member, group, general, { messageIds: [first.id] });
    expect(await access.personalCount(member, group)).toBe(0);
    await attention.markUnread(member, group, general, first.id);
    expect(await access.personalCount(member, group)).toBe(0);
    await expect(send(owner, general, 'Different content', root.id, request)).rejects.toThrow('different message');
  });
  it('filters existing personal attention immediately after blocking or muting', async () => {
    const name = (await db.user.findUniqueOrThrow({ where: { id: member } })).username;
    await send(owner, general, `@${name} Hello`);
    expect(await access.personalCount(member, group)).toBe(1);
    await db.userBlock.create({ data: { blockerId: member, blockedId: owner } });
    expect(await access.personalCount(member, group)).toBe(0);
    expect(await reader.personal(member, group)).toHaveLength(0);
    expect((await channels.details(member, group, general)).personalCount).toBe(0);
    await db.userBlock.delete({ where: { blockerId_blockedId: { blockerId: member, blockedId: owner } } });
    await db.userMute.create({ data: { muterId: member, mutedId: owner } });
    expect(await access.personalCount(member, group)).toBe(0);
  });
  it('keeps announcement replies leader-only and threads inside their channel', async () => {
    const root = await send(owner, announcements, 'An announcement');
    await expect(send(member, announcements, 'Reply', root.id)).rejects.toThrow('cannot post');
    await expect(send(member, general, 'Cross-channel reply', root.id)).rejects.toThrow('Thread unavailable');
  });
  it('discloses private history, revokes grants on departure, and never restores them on rejoin', async () => {
    const channel = await channels.create(owner, group, { name: 'planning', privacy: 'private' });
    const retained = await send(owner, channel.id, 'Retained');
    await expect(channels.addMember(owner, group, channel.id, member, false)).rejects.toThrow('history');
    await channels.addMember(owner, group, channel.id, member, true);
    expect((await reader.list(member, group, channel.id, {})).messages[0].id).toBe(retained.id);
    await db.$transaction(async tx => {
      await prepareChannelDeparture(tx, group, member, { forced: false });
      await tx.communityGroupMember.delete({ where: { groupId_userId: { groupId: group, userId: member } } });
    });
    await db.communityGroupMember.create({ data: { groupId: group, userId: member, status: 'active', role: 'member' } });
    await expect(reader.context(member, group, channel.id, retained.id)).rejects.toThrow('unavailable');
  });
  it('blocks voluntary loss of the last private leader but archives on forced loss', async () => {
    const channel = await channels.create(owner, group, { name: 'sole-leader', privacy: 'private' });
    await channels.addMember(owner, group, channel.id, member, true);
    await expect(db.$transaction(tx => prepareChannelDeparture(tx, group, owner, { forced: false }))).rejects.toThrow('another group leader');
    await db.$transaction(tx => prepareChannelDeparture(tx, group, owner, { forced: true }));
    expect(await channels.details(member, group, channel.id)).toMatchObject({ archivedAt: expect.any(String), capabilities: { canSend: false } });
    await expect(channels.details(moderator, group, channel.id)).rejects.toThrow('unavailable');
    await db.communityGroupMember.update({ where: { groupId_userId: { groupId: group, userId: member } }, data: { role: 'moderator' } });
    expect(await channels.update(member, group, channel.id, { archived: false })).toMatchObject({ archivedAt: null });
  });
  it('transfers ownership atomically without private-channel access inheritance', async () => {
    const channel = await channels.create(owner, group, { name: 'private', privacy: 'private' });
    await transferGroupOwnership(db as any, group, owner, member);
    expect(await db.communityGroupMember.findMany({ where: { groupId: group, role: 'owner' } })).toMatchObject([{ userId: member }]);
    expect(await db.communityGroupMember.findUnique({ where: { groupId_userId: { groupId: group, userId: owner } } })).toMatchObject({ role: 'moderator' });
    await expect(channels.details(member, group, channel.id)).rejects.toThrow('unavailable');
  });
  it('keeps deleted roots usable as placeholders while removing search, pins and attention', async () => {
    const root = await send(owner, general, 'Find this root');
    await send(member, general, 'Retain my reply', root.id);
    await messages.pin(owner, group, general, root.id, true);
    await messages.delete(owner, group, general, root.id);
    expect((await reader.context(member, group, general, root.id)).messages.find(row => row.id === root.id)).toMatchObject({ body: '', deletedForAll: true });
    expect((await reader.list(member, group, general, { root: root.id })).messages).toHaveLength(1);
    expect((await reader.search(member, group, { q: 'Find this', channelId: general })).messages).toHaveLength(0);
    expect(await reader.pins(member, group, general)).toHaveLength(0);
  });
  it('returns every change after a revision for reconnect catch-up, including tombstones', async () => {
    const reacted = await send(owner, general, 'React to me while offline');
    const removed = await send(owner, general, 'Delete me while offline');
    const seen = removed.revision;
    const added = await send(member, general, 'Sent while offline');
    await messages.reaction(member, group, general, reacted.id, 'check', true);
    await messages.delete(owner, group, general, removed.id);
    const changes = await reader.list(member, group, general, { changedSince: seen });
    expect(changes.messages.map(row => row.id)).toEqual([added.id, reacted.id, removed.id]);
    expect(changes.messages.at(-1)).toMatchObject({ deletedForAll: true, body: '' });
    expect((await reader.list(member, group, general, { changedSince: seen, limit: 2 })).nextCursor).toBe(changes.messages[1]!.revision);
  });
  it('omits deleted replies and deleted roots once no reply remains', async () => {
    const root = await send(owner, general, 'Root to remove');
    const reply = await send(member, general, 'Reply to remove', root.id);
    await messages.delete(owner, group, general, root.id);
    expect((await reader.list(member, group, general, {})).messages.map(row => row.id)).toContain(root.id);
    await messages.delete(member, group, general, reply.id);
    expect((await reader.list(member, group, general, { root: root.id })).messages).toHaveLength(0);
    expect((await reader.list(member, group, general, {})).messages.map(row => row.id)).not.toContain(root.id);
    await expect(reader.context(member, group, general, root.id)).rejects.toThrow('unavailable');
  });
  it('enforces MARV retrieval scope against real private grants and cancels after removal', async () => {
    await db.user.update({ where: { id: owner }, data: { premium: true } });
    await db.marvinUserSettings.create({ data: { userId: owner, aiConsentAt: new Date(), aiConsentVersion: 2 } });
    const bot = await db.user.create({ data: { username: `marv_${randomUUID().slice(0, 8)}`, isBot: true, botType: 'marvin' } });
    await db.communityGroupMember.create({ data: { groupId: group, userId: bot.id, status: 'active', role: 'member' } });
    const privateX = await channels.create(owner, group, { name: 'private-x', privacy: 'private' });
    const privateY = await channels.create(owner, group, { name: 'private-y', privacy: 'private' });
    const normal = await send(owner, general, 'Shared decision');
    const privateMessage = await send(owner, privateX.id, 'Private decision X');
    await send(owner, privateY.id, 'Private decision Y');
    const marvConfig: any = { groupChannels: () => ({ enabled: true, groupIds: [] }), marvBot: () => ({ enabled: true, userId: bot.id, username: bot.username }) };
    const scope = new ChannelMarvScopeService(db as any, marvConfig, access, realtime);
    const trigger = await send(owner, privateX.id, `@${bot.username} help`);
    const request = { groupId: group, channelId: privateX.id, messageId: trigger.id, requesterId: owner };
    await expect(scope.authorize(request)).rejects.toThrow();
    await scope.participation(owner, group, privateX.id, true, true);
    const { grant } = await scope.authorize(request);
    const rows = await scope.retrieve(request, grant, 'decision');
    expect(new Set(rows.map(row => row.id))).toEqual(new Set([normal.id, privateMessage.id]));
    await scope.participation(owner, group, privateX.id, false, false);
    await expect(scope.validateEvidence(request, grant, rows)).rejects.toThrow();
    await scope.participation(owner, group, general, true, true);
    const normalTrigger = await send(owner, general, `@${bot.username} help`);
    const normalRequest = { ...request, channelId: general, messageId: normalTrigger.id };
    const normalGrant = (await scope.authorize(normalRequest)).grant;
    expect((await scope.retrieve(normalRequest, normalGrant, 'decision')).map(row => row.id)).toEqual([normal.id]);
  });

});
