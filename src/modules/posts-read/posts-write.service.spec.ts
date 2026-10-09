import { PostsWriteService } from './posts-write.service';

function setup() {
  const post = { updateMany: jest.fn(async () => ({ count: 1 })), update: jest.fn(async () => ({})), create: jest.fn(async () => ({})) };
  const user = { findUnique: jest.fn(async () => ({ isBot: true, botType: 'marvin' })) };
  return { service: new PostsWriteService({ post, user } as never), post, user };
}

describe('PostsWriteService fixed commands', () => {
  it('crosspost results cannot smuggle arbitrary post content or visibility writes', async () => {
    const { service, post } = setup();
    await service.recordCrosspostResult('post', 'x', { url: 'https://x.test/p', error: null, body: 'changed', visibility: 'public' } as { url: string; error: null });
    expect(post.updateMany).toHaveBeenCalledWith({ where: { id: 'post' }, data: { xUrl: 'https://x.test/p', xError: null } });
    await service.recordCrosspostResult('post', 'pickax', { error: 'retry' });
    expect(post.updateMany).toHaveBeenLastCalledWith({ where: { id: 'post' }, data: { pickaxError: 'retry' } });
  });

  it('pins only an active post in the requested group using the same transaction', async () => {
    const { service, post } = setup();
    const tx = { post: { updateMany: jest.fn(async () => ({ count: 1 })), update: jest.fn(async () => ({})) } };
    const at = new Date();
    await service.replaceGroupPin(tx as never, 'group', 'post', at);
    expect(tx.post.updateMany).toHaveBeenCalledWith({ where: { communityGroupId: 'group', pinnedInGroupAt: { not: null } }, data: { pinnedInGroupAt: null } });
    expect(tx.post.update).toHaveBeenCalledWith({ where: { id: 'post', communityGroupId: 'group', deletedAt: null }, data: { pinnedInGroupAt: at } });
    expect(post.update).not.toHaveBeenCalled();
  });

  it('Board repairs and article synchronization cannot target ordinary posts', async () => {
    const { service, post } = setup();
    await service.clearArticleMirrorBodies(['post']);
    expect(post.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['post'] }, kind: 'board', articleId: { not: null }, parentId: null }, data: { body: '' } });
    await service.setArticleBoardVisibility(['post'], 'verifiedOnly');
    expect(post.updateMany).toHaveBeenLastCalledWith({ where: { id: { in: ['post'] }, kind: 'board', articleId: { not: null }, parentId: null, deletedAt: null }, data: { visibility: 'verifiedOnly' } });
  });

  it('keeps introduction seeding separate from publication and refuses human authors', async () => {
    const { service, post, user } = setup();
    user.findUnique.mockResolvedValueOnce({ isBot: false, botType: 'marvin' });
    await expect(service.seedMarvIntroduction('human')).rejects.toThrow('Only Marv');
    expect(post.create).not.toHaveBeenCalled();
    await service.seedMarvIntroduction('bot');
    expect(post.create).toHaveBeenCalledWith({ data: { userId: 'bot', body: 'Hello, men!', visibility: 'verifiedOnly', kind: 'regular' } });
  });
});
