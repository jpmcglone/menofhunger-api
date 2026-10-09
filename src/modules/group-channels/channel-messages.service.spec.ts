import { createHash } from 'node:crypto';
import { makeChannelMessages } from './channel-messages.testing';

function harness() {
  const channel = { id: 'channel', groupId: 'group', conversationId: 'conversation', defaultPurpose: null, privacy: 'normal', archivedAt: null, lastSequence: 0 };
  const tx: any = {
    message: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn() },
    groupChannel: { update: jest.fn().mockResolvedValue({ ...channel, lastSequence: 1 }) },
    groupChannelThreadState: { upsert: jest.fn(), updateMany: jest.fn() },
  };
  const prisma: any = { $transaction: jest.fn(async fn => fn(tx)) };
  const access: any = { lockGroup: jest.fn(), channel: jest.fn().mockResolvedValue({ channel, member: { role: 'member' } }) };
  const attention: any = { reconcile: jest.fn() };
  const { reader, writer: service } = makeChannelMessages({
    prisma,
    access,
    channels: {} as any,
    attention,
    config: { groupChannels: () => ({}) } as any,
    realtime: {} as any,
    media: {} as any,
    effects: { dispatch: jest.fn() } as any,
  });
  // Delivery/mapping is covered separately; isolate the transactional protocol here.
  jest.spyOn(reader, 'broadcast').mockResolvedValue(undefined);
  jest.spyOn(reader, 'present').mockImplementation(async (_u, _g, _c, rows) => rows as never);
  return { service, reader, tx, access, attention, channel };
}

describe('channel send protocol', () => {
  const input = { body: 'Ready for tomorrow?', clientRequestId: 'request-1' };
  it('returns the committed message after a timeout/retry without new sequence or attention', async () => {
    const h = harness();
    const existing = { id: 'original', requestHash: createHash('sha256').update(JSON.stringify({ body: input.body, threadRootId: null, uploadId: null, thumbnailUploadId: null, alt: null, giphy: null })).digest('hex') };
    h.tx.message.findUnique.mockResolvedValue(existing);
    await expect(h.service.send('viewer', 'group', 'channel', input)).resolves.toEqual(existing);
    expect(h.tx.message.create).not.toHaveBeenCalled();
    expect(h.tx.groupChannel.update).not.toHaveBeenCalled();
    expect(h.attention.reconcile).not.toHaveBeenCalled();
  });
  it('consumes each of up to four attachments and rejects a fifth or a duplicate', async () => {
    const h = harness();
    const consume = jest.fn(async (_tx, _user, _channel, uploadId: string) => ({ source: 'upload', kind: 'image', r2Key: uploadId }));
    (h.service as any).media = { consume };
    h.tx.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new-message', ...data }));
    const four = ['a', 'b', 'c', 'd'].map(uploadId => ({ uploadId }));
    await h.service.send('viewer', 'group', 'channel', { ...input, attachments: four });
    expect(consume).toHaveBeenCalledTimes(4);
    await expect(h.service.send('viewer', 'group', 'channel', { ...input, attachments: [...four, { uploadId: 'e' }] })).rejects.toThrow('Attach up to 4');
    await expect(h.service.send('viewer', 'group', 'channel', { ...input, attachments: [{ uploadId: 'a' }, { uploadId: 'a' }] })).rejects.toThrow('Attach up to 4');
  });
  it('rejects request-ID reuse with changed content', async () => {
    const h = harness(); h.tx.message.findUnique.mockResolvedValue({ requestHash: 'different' });
    await expect(h.service.send('viewer', 'group', 'channel', input)).rejects.toThrow('different message');
    expect(h.tx.message.create).not.toHaveBeenCalled();
  });
  it('stores stable reference IDs under the group lock, and refuses cross-group forged tokens before writing', async () => {
    const h = harness();
    h.tx.groupChannel.findMany = jest.fn().mockResolvedValue([{ id: 'bugs', name: 'bugs', displayName: null, privacy: 'normal', access: [] }]);
    h.tx.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new-message', ...data }));
    const result = await h.service.send('viewer', 'group', 'channel', { ...input, body: 'Please use #bugs.' });
    expect(result.body).toBe('Please use <#bugs>.');
    expect(h.attention.reconcile).toHaveBeenCalledWith(h.tx, expect.objectContaining({ body: 'Please use <#bugs>.' }));
    h.tx.message.create.mockClear();
    await expect(h.service.send('viewer', 'group', 'channel', { ...input, body: 'Please use <#foreign>.' })).rejects.toThrow('reference is unavailable');
    expect(h.tx.message.create).not.toHaveBeenCalled();
  });
  it('rejects a reply whose target is not in this conversation', async () => {
    const h = harness();
    await expect(h.service.send('viewer', 'group', 'channel', { ...input, threadRootId: 'other-channel-message' })).rejects.toThrow('Thread unavailable');
    expect(h.tx.groupChannel.update).not.toHaveBeenCalled();
  });
  it('keeps a reply-to-reply inside the original root and preserves explicit unfollow', async () => {
    const h = harness(); h.tx.message.findFirst.mockResolvedValue({ id: 'reply', threadRootId: 'root' });
    h.tx.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new-message', ...data }));
    const result = await h.service.send('viewer', 'group', 'channel', { ...input, threadRootId: 'reply' });
    expect(result).toMatchObject({ threadRootId: 'root', channelSequence: 1 });
    expect(h.tx.groupChannelThreadState.updateMany).toHaveBeenCalledWith({ where: { rootMessageId: 'root', userId: 'viewer', unfollowed: false }, data: { following: true } });
  });
  it('stores an inline quoted reply only for a live message in this channel', async () => {
    const h = harness();
    h.tx.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new-message', ...data }));
    h.tx.message.findFirst.mockResolvedValueOnce({ id: 'quoted' });
    const result = await h.service.send('viewer', 'group', 'channel', { ...input, replyToId: 'quoted' });
    expect(h.tx.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'quoted', conversationId: 'conversation', deletedForAll: false }) }));
    expect(result).toMatchObject({ replyToId: 'quoted', threadRootId: null });
  });
  it('rejects an inline reply to a missing, deleted, or other-channel message', async () => {
    const h = harness();
    await expect(h.service.send('viewer', 'group', 'channel', { ...input, replyToId: 'elsewhere' })).rejects.toThrow('no longer available');
    expect(h.tx.message.create).not.toHaveBeenCalled();
  });
  it('enforces leader-only announcements at the mutation boundary', async () => {
    const h = harness(); h.channel.defaultPurpose = 'announcements' as any;
    await expect(h.service.send('viewer', 'group', 'channel', input)).rejects.toThrow('cannot post');
    expect(h.tx.message.create).not.toHaveBeenCalled();
  });
  it('counts readers for the sender only and never exceeds the other members', async () => {
    const h = harness();
    const prisma = (h.service as any).prisma;
    prisma.$queryRaw = jest.fn().mockResolvedValueOnce([{ id: 'mine', reads: 5 }]);
    h.access.recipients = jest.fn().mockResolvedValue([{ userId: 'viewer' }, { userId: 'a' }, { userId: 'b' }, { userId: 'c' }]);
    const rows = [
      { id: 'mine', senderId: 'viewer', deletedForAll: false, channelSequence: 3, threadRootId: null },
      { id: 'theirs', senderId: 'a', deletedForAll: false, channelSequence: 2, threadRootId: null },
      { id: 'gone', senderId: 'viewer', deletedForAll: true, channelSequence: 1, threadRootId: null },
    ];
    const receipts: Map<string, unknown> = await (h.reader as any).receipts('viewer', 'group', { id: 'channel', privacy: 'normal' }, rows);
    expect([...receipts.keys()]).toEqual(['mine']);
    expect(receipts.get('mine')).toEqual({ readCount: 3, recipientCount: 3 });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
  it('rechecks access before resolving an idempotency key', async () => {
    const h = harness(); h.access.channel.mockRejectedValue(new Error('Channel unavailable.'));
    await expect(h.service.send('viewer', 'group', 'channel', input)).rejects.toThrow('unavailable');
    expect(h.tx.message.findUnique).not.toHaveBeenCalled();
  });
});

describe('channel preview removal', () => {
  const message = { id: 'm1', senderId: 'author', body: 'see https://example.com/a', hiddenPreviews: [], threadRootId: null };
  it('lets the author hide a link that is in the message', async () => {
    const h = harness();
    jest.spyOn(h.service as any, 'advanceRevision').mockResolvedValue(undefined);
    h.tx.message.findFirst.mockResolvedValue(message);
    await h.service.hidePreview('author', 'group', 'channel', 'm1', 'https://example.com/a', true);
    expect(h.tx.message.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { hiddenPreviews: ['https://example.com/a'] } });
  });
  it('rejects links that are not in the message and non-authors', async () => {
    const h = harness();
    h.tx.message.findFirst.mockResolvedValue(message);
    await expect(h.service.hidePreview('author', 'group', 'channel', 'm1', 'https://evil.test', true)).rejects.toThrow('not in this message');
    h.tx.message.findFirst.mockResolvedValue(null);
    await expect(h.service.hidePreview('other', 'group', 'channel', 'm1', 'https://example.com/a', true)).rejects.toThrow('Only the author');
  });
});

describe('group join row and Welcome', () => {
  function joinHarness() {
    const h = harness();
    h.channel.defaultPurpose = 'general' as any;
    (h.access as any).enabled = jest.fn().mockReturnValue(true);
    h.tx.groupChannel.findUnique = jest.fn().mockResolvedValue(h.channel);
    h.tx.communityGroupMember = { findUnique: jest.fn().mockResolvedValue({ status: 'active', user: { bannedAt: null, isBot: false, verifiedStatus: 'identity' } }) };
    h.tx.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'join-row', ...data }));
    return h;
  }
  it('records one silent groupJoin row with the next sequence and broadcasts it', async () => {
    const h = joinHarness();
    await h.service.recordJoin('group', 'newbie', '2026-10-08T12:00:00.000Z');
    expect(h.tx.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'groupJoin', body: '', senderId: 'newbie', clientRequestId: 'join:2026-10-08T12:00:00.000Z', channelSequence: 1 }) });
    expect(h.attention.reconcile).not.toHaveBeenCalled();
    expect((h.service as any).effects.dispatch).not.toHaveBeenCalled();
    expect(h.reader.broadcast).toHaveBeenCalledWith('group', 'channel', 'join-row');
  });
  it('is idempotent on retry and skips inactive or banned members and channels that are gone', async () => {
    const h = joinHarness();
    h.tx.message.findFirst.mockResolvedValue({ id: 'already' });
    await h.service.recordJoin('group', 'newbie', 'at');
    h.tx.message.findFirst.mockResolvedValue(null);
    h.tx.communityGroupMember.findUnique.mockResolvedValue({ status: 'pending', user: { bannedAt: null, isBot: false, verifiedStatus: 'identity' } });
    await h.service.recordJoin('group', 'newbie', 'at2');
    h.tx.communityGroupMember.findUnique.mockResolvedValue({ status: 'active', user: { bannedAt: new Date(), isBot: false, verifiedStatus: 'identity' } });
    await h.service.recordJoin('group', 'newbie', 'at3');
    h.tx.groupChannel.findUnique.mockResolvedValue(null);
    await h.service.recordJoin('group', 'newbie', 'at4');
    expect(h.tx.message.create).not.toHaveBeenCalled();
  });
  it('does nothing when channels are not enabled for the group', async () => {
    const h = joinHarness(); (h.access as any).enabled.mockReturnValue(false);
    await h.service.recordJoin('group', 'newbie', 'at');
    expect((h.service as any).prisma.$transaction).not.toHaveBeenCalled();
  });
  it('Welcome posts "Welcome, <first name> 🤝" once under a stable request id, then refreshes the row', async () => {
    const h = joinHarness();
    (h.service as any).prisma.message = { findFirst: jest.fn().mockResolvedValue({ id: 'join-row', senderId: 'newbie', sender: { name: 'Chris Hale', username: 'chris' } }) };
    const send = jest.spyOn(h.service, 'send').mockResolvedValue({ id: 'welcome-msg' } as any);
    jest.spyOn(h.service as any, 'advanceRevision').mockResolvedValue(undefined);
    await expect(h.service.welcome('viewer', 'group', 'channel', 'join-row')).resolves.toEqual({ id: 'welcome-msg' });
    expect(send).toHaveBeenCalledWith('viewer', 'group', 'channel', { body: 'Welcome, Chris 🤝', clientRequestId: 'welcome:join-row' });
    expect(h.reader.broadcast).toHaveBeenCalledWith('group', 'channel', 'join-row');
  });
  it('Welcome rejects welcoming yourself and non-join rows', async () => {
    const h = joinHarness();
    const prisma = (h.service as any).prisma;
    prisma.message = { findFirst: jest.fn().mockResolvedValue({ id: 'join-row', senderId: 'viewer', sender: { name: 'Me', username: 'me' } }) };
    await expect(h.service.welcome('viewer', 'group', 'channel', 'join-row')).rejects.toThrow('yourself');
    prisma.message.findFirst.mockResolvedValue(null);
    await expect(h.service.welcome('viewer', 'group', 'channel', 'text-row')).rejects.toThrow('unavailable');
    expect(prisma.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ kind: 'groupJoin' }) }));
  });
  it('shows the button only to others who have not welcomed, and never lets the joiner edit the row', () => {
    const h = joinHarness();
    (h.reader as any).config = { r2: () => null };
    const base = { id: 'join-row', createdAt: new Date(), body: '', conversationId: 'conversation', sender: { id: 'newbie', username: 'chris', name: 'Chris', avatarKey: null }, kind: 'groupJoin', media: [], reactions: [], deletions: [], deletedForAll: false, channelPins: [], threadReplies: [], _count: { threadReplies: 0 }, channelRevision: 1, channelSequence: 1, hiddenPreviews: [], senderId: 'newbie', replyTo: null, threadRootId: null };
    const render = (viewer: string, welcomed = new Set<string>()) => (h.reader as any).render(viewer, 'member', 'group', h.channel, [base], new Set(), new Map(), welcomed)[0];
    expect(render('viewer').joinWelcome).toEqual({ canWelcome: true });
    expect(render('viewer', new Set(['join-row'])).joinWelcome).toEqual({ canWelcome: false });
    const own = render('newbie');
    expect(own.joinWelcome).toEqual({ canWelcome: false });
    expect(own.canEdit).toBe(false);
  });
});
