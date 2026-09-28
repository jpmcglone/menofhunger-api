import { MarvinMemoryService } from './marvin-memory.service';
import { memoryScore } from './marvin-memory-policy';

const question = 'What do we know about marathon training?';
const ctx = { requesterUserId: 'viewer', triggeringPostId: 'focal', rootPostId: 'focal' };
const privateCtx = { requesterUserId: 'viewer', conversationId: 'dm-a', requesterMessageId: 'current' };
const post = (overrides: Record<string, unknown> = {}) => ({
  id: 'evidence', body: 'Marathon training starts Monday.', createdAt: new Date('2026-01-01'), editedAt: null,
  deletedAt: null, isDraft: false, visibility: 'public', communityGroupId: null, parentId: null, rootId: null,
  topics: ['fitness'], userId: 'author', user: { username: 'runner', isBot: false, bannedAt: null }, root: null, boardThread: null,
  ...overrides,
});
const record = (scopeKey = 'public', evidence = post()) => ({
  id: 'memory', scopeKey, learnedAt: new Date(), post: evidence, message: null,
});
function setup() {
  const prisma = {
    user: { findFirst: jest.fn().mockResolvedValue({ id: 'viewer' }) },
    userBlock: { findMany: jest.fn().mockResolvedValue([]) },
    post: { findFirst: jest.fn().mockResolvedValue(post({ id: 'focal' })), findMany: jest.fn().mockResolvedValue([]) },
    communityGroupMember: { findFirst: jest.fn().mockResolvedValue({ userId: 'viewer' }) },
    messageConversation: { findFirst: jest.fn().mockResolvedValue({ id: 'dm-a' }) },
    message: { findFirst: jest.fn().mockResolvedValue({ id: 'current' }), findMany: jest.fn().mockResolvedValue([]) },
    marvinMemorySource: { createMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([]) },
  };
  const posts = { getById: jest.fn().mockResolvedValue({}) };
  return { prisma, posts, service: new MarvinMemoryService(prisma as any, posts as any) };
}

it('never lets recency make an unrelated memory relevant, and preserves stronger relevance', () => {
  const now = new Date('2026-09-28');
  expect(memoryScore(question, 'The lodge picnic is tomorrow.', now, now)).toBeNull();
  expect(memoryScore('What is 15% of 80?', 'The lodge picnic is tomorrow.', now, now)).toBeNull();
  expect(memoryScore('marathon training schedule recovery', 'marathon training schedule recovery', new Date('2020-01-01'), now))
    .toBeGreaterThan(memoryScore('marathon training schedule recovery', 'marathon training', now, now)!);
});
it('uses learned time independently of publication time without resetting it on recall', async () => {
  const { prisma, service } = setup();
  const old = record(); old.learnedAt = new Date('2026-09-28');
  prisma.marvinMemorySource.findMany.mockResolvedValue([old]);
  const result: any = await service.recall(ctx, 'public_thread', question);
  expect(result.memories[0]).toMatchObject({ learnedAt: old.learnedAt, publishedAt: new Date('2026-01-01'), author: 'runner' });
  expect(prisma.marvinMemorySource.createMany).not.toHaveBeenCalled();
});
it('queries public scopes only in a public reply and discards protected records even if returned', async () => {
  const { prisma, service } = setup();
  prisma.marvinMemorySource.findMany.mockResolvedValue([record('group:other'), record('conversation:dm-a'), record()]);
  const result: any = await service.recall(ctx, 'public_thread', question);
  expect(prisma.marvinMemorySource.findMany.mock.calls[0][0].where.scopeKey.in).toEqual(['public', 'public', 'thread:focal']);
  expect(result.memories).toHaveLength(1);
  expect(result.memories[0].scope).toBe('public');
});
it('permits public and same-group evidence but never other-group evidence', async () => {
  const { prisma, service } = setup();
  prisma.post.findFirst.mockResolvedValue(post({ id: 'focal', communityGroupId: 'g-a' }));
  prisma.marvinMemorySource.findMany.mockResolvedValue([
    record('group:g-a', post({ communityGroupId: 'g-a' })), record('group:g-b', post({ communityGroupId: 'g-b' })), record(),
  ]);
  const result: any = await service.recall(ctx, 'public_thread', question);
  expect(result.memories.map((m: any) => m.scope).sort()).toEqual(['group:g-a', 'public']);
  expect(prisma.communityGroupMember.findFirst.mock.calls[0][0].where).toMatchObject({ groupId: 'g-a', status: 'active', group: { deletedAt: null } });
});
it('rechecks group membership on every recall, including after it is revoked', async () => {
  const { prisma, service } = setup();
  prisma.post.findFirst.mockResolvedValue(post({ id: 'focal', communityGroupId: 'g-a' }));
  await service.recall(ctx, 'public_thread', question);
  prisma.marvinMemorySource.findMany.mockClear();
  prisma.communityGroupMember.findFirst.mockResolvedValue(null);
  expect(await service.recall(ctx, 'public_thread', question)).toEqual({ memories: [] });
  expect(prisma.marvinMemorySource.findMany).not.toHaveBeenCalled();
});
it('private conversations cannot recall any other private or group context', async () => {
  const { prisma, service } = setup();
  const message = { id: 'message', body: 'Marathon training starts Monday.', conversationId: 'dm-a', createdAt: new Date(), editedAt: null, sender: { username: 'runner', isBot: false } };
  prisma.marvinMemorySource.findMany.mockResolvedValue([
    { ...record(), scopeKey: 'conversation:dm-a', post: null, message },
    { ...record(), scopeKey: 'conversation:dm-b', post: null, message: { ...message, conversationId: 'dm-b' } },
    record('group:g-a', post({ communityGroupId: 'g-a' })), record(),
  ]);
  const result: any = await service.recall(privateCtx, 'private_session', question);
  expect(result.memories.map((m: any) => m.scope).sort()).toEqual(['conversation:dm-a', 'public']);
  expect(prisma.marvinMemorySource.findMany.mock.calls[0][0].where.scopeKey.in).toEqual(['public', 'conversation:dm-a']);
});
it('requires current accepted conversation membership and the actual requester message', async () => {
  const { prisma, service } = setup();
  prisma.messageConversation.findFirst.mockResolvedValue(null);
  expect(await service.recall(privateCtx, 'private_session', question)).toEqual({ memories: [] });
  expect(prisma.marvinMemorySource.findMany).not.toHaveBeenCalled();
  prisma.messageConversation.findFirst.mockResolvedValue({ id: 'dm-a' });
  prisma.message.findFirst.mockResolvedValue(null);
  expect(await service.recall(privateCtx, 'private_session', question)).toEqual({ memories: [] });
});
it('does not promote a previously group-scoped source after it becomes public', async () => {
  const { prisma, service } = setup();
  prisma.marvinMemorySource.findMany.mockResolvedValue([record('group:g-a', post())]);
  expect((await service.recall(ctx, 'public_thread', question) as any).memories).toEqual([]);
});
it.each([
  { deletedAt: new Date() }, { isDraft: true }, { visibility: 'onlyMe' },
  { communityGroupId: 'g-a' }, { user: { username: 'marv', isBot: true, bannedAt: null } },
  { user: { username: 'runner', isBot: false, bannedAt: new Date() } },
])('rejects a source that is no longer eligible: %j', async change => {
  const { prisma, service } = setup();
  prisma.marvinMemorySource.findMany.mockResolvedValue([record('public', post(change))]);
  expect((await service.recall(ctx, 'public_thread', question) as any).memories).toEqual([]);
});
it('does not expose public-looking replies beneath restricted ancestors', async () => {
  const { prisma, service } = setup();
  prisma.post.findFirst.mockImplementation(async ({ where }: any) => where.id === 'parent'
    ? { id: 'parent', parentId: 'root', rootId: 'root', communityGroupId: null, visibility: 'premiumOnly', deletedAt: null, isDraft: false }
    : where.id === 'root' ? post({ id: 'root' }) : post({ id: 'focal' }));
  prisma.marvinMemorySource.findMany.mockResolvedValue([record('public', post({ parentId: 'parent', rootId: 'root', root: post({ id: 'root' }) }))]);
  expect((await service.recall(ctx, 'public_thread', question) as any).memories).toEqual([]);
});
it('revalidates post access and filters both directions of blocking in source queries', async () => {
  const { prisma, posts, service } = setup();
  prisma.userBlock.findMany.mockResolvedValue([{ blockerId: 'other', blockedId: 'viewer' }]);
  prisma.marvinMemorySource.findMany.mockResolvedValue([record()]);
  posts.getById.mockImplementation(async ({ id }: any) => { if (id === 'evidence') throw new Error('no access'); return {}; });
  expect((await service.recall(ctx, 'public_thread', question) as any).memories).toEqual([]);
  expect(prisma.marvinMemorySource.findMany.mock.calls[0][0].where.OR[0].post.userId).toEqual({ notIn: ['other'] });
});
it('stores only source references with immutable first-learned time; never bot output', async () => {
  const { prisma, service } = setup();
  prisma.post.findMany.mockResolvedValue([post(), post({ id: 'bot', user: { username: 'marv', isBot: true, bannedAt: null } })]);
  await service.prepare(ctx, 'public_thread');
  await service.prepare(ctx, 'public_thread');
  for (const [write] of prisma.marvinMemorySource.createMany.mock.calls) {
    expect(write).toEqual({ data: [{ scopeKey: 'public', postId: 'evidence' }], skipDuplicates: true });
  }
});
it('keeps private history live, excludes per-user deletions, and learns only human messages', async () => {
  const { prisma, service } = setup();
  prisma.message.findMany.mockResolvedValue([
    { id: 'bot', body: 'Previous answer', createdAt: new Date(), sender: { username: 'marv', isBot: true } },
    { id: 'old', body: 'My training plan', createdAt: new Date(), sender: { username: 'runner', isBot: false } },
  ]);
  const context = await service.prepare(privateCtx, 'private_session');
  expect(JSON.parse(context!)).toHaveLength(2);
  expect(prisma.message.findMany.mock.calls[0][0].where).toMatchObject({ conversationId: 'dm-a', deletedForAll: false, deletions: { none: { userId: 'viewer' } } });
  expect(prisma.marvinMemorySource.createMany).toHaveBeenCalledWith({ data: [{ scopeKey: 'conversation:dm-a', messageId: 'old' }], skipDuplicates: true });
});
it('fails closed on mixed context IDs and does not index admin or background work', async () => {
  const { prisma, service } = setup();
  expect(await service.prepare({ ...ctx, conversationId: 'dm-a' }, 'public_thread')).toBeNull();
  expect(await service.prepare(ctx, 'admin_console')).toBeNull();
  expect(prisma.marvinMemorySource.createMany).not.toHaveBeenCalled();
});
it('returns no memory when optional storage is unavailable', async () => {
  const { prisma, service } = setup();
  prisma.marvinMemorySource.findMany.mockRejectedValue(new Error('unavailable'));
  expect(await service.recall(ctx, 'public_thread', question)).toEqual({ memories: [], unavailable: true });
});

it('learns normal verified-only group posts across the same group, but keeps premium posts in their thread', async () => {
  const { prisma, service } = setup();
  prisma.post.findFirst.mockResolvedValue(post({ id: 'focal', communityGroupId: 'g-a', visibility: 'verifiedOnly' }));
  const normal = post({ communityGroupId: 'g-a', visibility: 'verifiedOnly' });
  const restricted = post({ id: 'restricted', communityGroupId: 'g-a', visibility: 'premiumOnly' });
  prisma.post.findMany.mockResolvedValue([normal, restricted]);
  await service.prepare(ctx, 'public_thread');
  for (const [write] of prisma.marvinMemorySource.createMany.mock.calls) {
    expect(write.data).toEqual([{ scopeKey: 'group:g-a', postId: 'evidence' }]);
  }
  prisma.marvinMemorySource.findMany.mockResolvedValue([record('group:g-a', normal), record('thread:restricted', restricted)]);
  expect((await service.recall(ctx, 'public_thread', question) as any).memories.map((m: any) => m.scope)).toEqual(['group:g-a']);
});

it('does not recall a narrower branch into a broader reply in the same root thread', async () => {
  const { prisma, service } = setup();
  prisma.marvinMemorySource.findMany.mockResolvedValue([record('thread:focal', post({
    visibility: 'premiumOnly', parentId: 'focal', rootId: 'focal', root: post({ id: 'focal' }),
  }))]);
  expect((await service.recall(ctx, 'public_thread', question) as any).memories).toEqual([]);
});
