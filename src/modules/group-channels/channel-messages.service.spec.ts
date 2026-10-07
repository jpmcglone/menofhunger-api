import { createHash } from 'node:crypto';
import { ChannelMessagesService } from './channel-messages.service';

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
  const service = new ChannelMessagesService(prisma, access, {} as any, attention, { groupChannels: () => ({}) } as any, {} as any, {} as any, { dispatch: jest.fn() } as any);
  // Delivery/mapping is covered separately; isolate the transactional protocol here.
  jest.spyOn(service as any, 'broadcast').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'present').mockImplementation(async (_u, _g, _c, rows) => rows);
  return { service, tx, access, attention, channel };
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
    const receipts: Map<string, unknown> = await (h.service as any).receipts('viewer', 'group', { id: 'channel', privacy: 'normal' }, rows);
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
