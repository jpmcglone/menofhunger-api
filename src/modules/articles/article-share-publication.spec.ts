import { ArticleEngagementService } from './article-engagement.service';

function setup() {
  const article = { id: 'article', title: 'Article', excerpt: 'Preview', visibility: 'verifiedOnly', deletedAt: null, isDraft: false, author: { id: 'writer', username: 'writer' } };
  const post = { id: 'share', userId: 'author', body: '', visibility: 'verifiedOnly', createdAt: new Date(), kind: 'articleShare', user: { id: 'author', username: 'author', orgMemberships: [] }, mentions: [], media: [], article };
  const prisma = { article: { findUnique: jest.fn(async () => article) } };
  const writes = { createArticleShare: jest.fn(async () => post) };
  const access = { assertAccessible: jest.fn(async () => article) };
  return { service: new ArticleEngagementService(prisma as never, { r2: () => ({ publicBaseUrl: 'https://cdn.test' }) } as never, {} as never, {} as never, writes as never, access as never), prisma, article, post, writes, access };
}

describe('article share publication', () => {
  it('keeps source permission and visibility checks before the owned post command and preserves the envelope payload', async () => {
    const { service, writes, access } = setup();
    const result = await service.createSharePost('author', 'article', 'commentary');
    expect(access.assertAccessible).toHaveBeenCalledWith('article', 'author');
    expect(writes.createArticleShare).toHaveBeenCalledWith({ userId: 'author', articleId: 'article', body: 'commentary', visibility: 'verifiedOnly' });
    expect(access.assertAccessible.mock.invocationCallOrder[0]).toBeLessThan(writes.createArticleShare.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ post: { id: 'share', article: { id: 'article', title: 'Article' } }, article: { id: 'article', title: 'Article', excerpt: 'Preview' } });
  });

  it.each(['deleted', 'draft', 'more-public', 'denied'])('refuses %s sources without creating a post', async reason => {
    const { service, article, writes, access } = setup();
    if (reason === 'deleted') article.deletedAt = new Date() as never;
    if (reason === 'draft') article.isDraft = true;
    if (reason === 'denied') access.assertAccessible.mockRejectedValueOnce(new Error('denied'));
    await expect(service.createSharePost('author', 'article', '', reason === 'more-public' ? 'public' : undefined)).rejects.toThrow();
    expect(writes.createArticleShare).not.toHaveBeenCalled();
  });
});
