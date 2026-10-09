import { NotFoundException } from '@nestjs/common';
import { ArticleAccessService } from './article-access.service';
import { articleIncludes, commentIncludes, commentLeafIncludes } from './articles.includes';

function makeAccess(article: unknown, viewer?: { allowed?: string[] }) {
  const prisma = { article: { findUnique: jest.fn(async () => article) } };
  const viewerContext = {
    getViewer: jest.fn(async () => ({ id: 'viewer' })),
    allowedPostVisibilities: jest.fn(() => viewer?.allowed ?? ['public']),
  };
  return { access: new ArticleAccessService(prisma as never, viewerContext as never), viewerContext };
}

const published = { id: 'a1', isDraft: false, deletedAt: null, visibility: 'public', authorId: 'author' };

describe('ArticleAccessService.assertAccessible', () => {
  it('allows a published public article for anonymous viewers', async () => {
    await expect(makeAccess(published).access.assertAccessible('a1', null)).resolves.toBeUndefined();
  });

  it('hides missing and deleted articles', async () => {
    await expect(makeAccess(null).access.assertAccessible('a1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(makeAccess({ ...published, deletedAt: new Date() }).access.assertAccessible('a1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('shows drafts only to their author', async () => {
    const draft = { ...published, isDraft: true };
    await expect(makeAccess(draft).access.assertAccessible('a1', 'someone')).rejects.toBeInstanceOf(NotFoundException);
    await expect(makeAccess(draft).access.assertAccessible('a1', 'author')).resolves.toBeUndefined();
  });

  it('enforces visibility tiers but lets the author through', async () => {
    const premiumOnly = { ...published, visibility: 'premiumOnly' };
    await expect(makeAccess(premiumOnly, { allowed: ['public'] }).access.assertAccessible('a1', 'viewer')).rejects.toBeInstanceOf(NotFoundException);
    await expect(makeAccess(premiumOnly, { allowed: ['public', 'premiumOnly'] }).access.assertAccessible('a1', 'viewer')).resolves.toBeUndefined();
    await expect(makeAccess(premiumOnly, { allowed: ['public'] }).access.assertAccessible('a1', 'author')).resolves.toBeUndefined();
  });
});

describe('article include builders', () => {
  it('only loads the viewer boost row when a viewer is given', () => {
    expect(articleIncludes(true, true, 'u1').boosts).toEqual({ where: { userId: 'u1' }, select: { userId: true }, take: 1 });
    expect(articleIncludes(true, true).boosts).toBe(false);
    expect('boosts' in articleIncludes(true, false)).toBe(false);
    expect('reactions' in articleIncludes(false, false)).toBe(false);
  });

  it('nests leaf includes under comment replies', () => {
    expect(commentIncludes().replies.include).toEqual(commentLeafIncludes());
    expect(commentIncludes().replies.take).toBe(3);
  });
});
