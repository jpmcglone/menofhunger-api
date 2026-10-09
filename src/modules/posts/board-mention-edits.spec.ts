import { makePostsMutationServices } from './posts-mutation.testing';

function fixture() {
  const original = {
    id: 'board', userId: 'author', kind: 'board', body: '@old @existing',
    visibility: 'public', createdAt: new Date(), editCount: 0, deletedAt: null,
    parentId: null, poll: null, topics: [], hashtags: [], hashtagCasings: [],
    mentions: [{ userId: 'old' }, { userId: 'existing' }], user: { premium: true },
  };
  let savedIds: string[] = [];
  const tx = {
    hashtagVariant: { deleteMany: jest.fn(async () => ({})) },
    hashtag: { deleteMany: jest.fn(async () => ({})) },
    postVersion: { create: jest.fn(async () => ({})) },
    post: { update: jest.fn(async ({ data }: any) => ({ ...original, ...data, mentions: [] })) },
    postMention: {
      deleteMany: jest.fn(async () => ({})),
      createMany: jest.fn(async ({ data }: any) => { savedIds = data.map((row: any) => row.userId); }),
      findMany: jest.fn(async () => savedIds.map(id => ({ userId: id, user: { id, username: id } }))),
    },
  };
  const prisma = { post: { findUnique: jest.fn(async () => original) }, $transaction: (fn: any) => fn(tx) };
  const effects = { dispatch: jest.fn() };
  const { support, edits: service } = makePostsMutationServices(
    prisma as any, { emitPostsLiveUpdated: jest.fn() } as any,
    { bumpForPostWrite: jest.fn(async () => undefined) } as any,
    { marvBot: () => ({ username: 'marv' }), frontendBaseUrl: () => 'https://menofhunger.com' } as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    effects as any, { enqueueIfNeeded: jest.fn(async () => undefined) } as any,
  );
  jest.spyOn(support, 'resolveMentionUsernames').mockImplementation(async (names: any) => names);
  return { service, tx, effects };
}

describe('Board mention persistence on edit', () => {
  it('removes stale references, returns new references, and dispatches only additions', async () => {
    const { service, tx, effects } = fixture();
    const post = await service.updatePost({ userId: 'author', postId: 'board', body: '@existing @new @new' });
    expect(tx.postMention.createMany).toHaveBeenCalledWith({
      data: [{ postId: 'board', userId: 'existing' }, { postId: 'board', userId: 'new' }], skipDuplicates: true,
    });
    expect(post.mentions.map(mention => mention.user.id)).toEqual(['existing', 'new']);
    expect(effects.dispatch).toHaveBeenCalledWith('board.mentions.added', {
      postId: 'board', actorUserId: 'author', recipientIds: ['new'],
    });
  });
  it('clears all mentions when optional Board body text is removed', async () => {
    const { service, tx, effects } = fixture();
    const post = await service.updatePost({ userId: 'author', postId: 'board', body: '' });
    expect(tx.postMention.deleteMany).toHaveBeenCalled();
    expect(post.mentions).toEqual([]);
    expect(effects.dispatch).not.toHaveBeenCalled();
  });
  it('clears classification after edits even when keyword topics remain', async () => {
    const { service, tx } = fixture();
    await service.updatePost({ userId: 'author', postId: 'board', body: 'A dad playing World of Warcraft.' });
    expect(tx.post.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ topics: expect.arrayContaining(['fatherhood']), topicsClassifiedAt: null }),
    }));
  });
  it('does not notify unchanged recipients', async () => {
    const { service, effects } = fixture();
    await service.updatePost({ userId: 'author', postId: 'board', body: 'Edited: @existing @old' });
    expect(effects.dispatch).not.toHaveBeenCalled();
  });
});
