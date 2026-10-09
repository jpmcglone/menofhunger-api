import { PostsSharedWriteService } from './posts-shared-write.service';
import { PostsWriteAfterCommitService } from './posts-write-after-commit.service';
import { POST_LIST_INCLUDE } from '../../common/prisma-includes/post.include';
import { toPostDto } from '../../common/dto/post.dto';

function setup() {
  const post = {
    id: 'share', userId: 'author', body: '', visibility: 'public', kind: 'articleShare', createdAt: new Date(),
    user: { id: 'author', username: 'author', name: 'Author', verifiedStatus: 'identity', isBot: false, orgMemberships: [] },
    media: [], mentions: [],
    article: { id: 'article', title: 'Article', excerpt: 'Preview', visibility: 'public', author: { id: 'writer', username: 'writer' } },
    fitnessShare: { id: 'fitness', shareType: 'activity', snapshot: { type: 'activity', data: { distanceM: 1000 } } },
  };
  const create = jest.fn(async (query: { data: { kind: string; articleId?: string; fitnessShareId?: string } }) => ({
    ...post,
    ...query.data,
    article: query.data.articleId ? post.article : null,
    fitnessShare: query.data.fitnessShareId ? post.fitnessShare : null,
  }));
  const cache = { bumpForPostWrite: jest.fn(async () => undefined) };
  const ranking = { enqueueScoreRefresh: jest.fn() };
  const sideEffects = { dispatch: jest.fn() };
  const realtime = { emitGroupNewPost: jest.fn(), emitPostsCommentAdded: jest.fn() };
  const afterCommit = new PostsWriteAfterCommitService(
    { r2: () => ({ publicBaseUrl: 'https://cdn.test' }) } as never,
    cache as never, { capture: jest.fn() } as never, {} as never, realtime as never, ranking as never, sideEffects as never,
  );
  return { service: new PostsSharedWriteService({ post: { create } } as never, afterCommit), create, post, cache, ranking, sideEffects, realtime };
}

describe('shared post publication lifecycle', () => {
  it.each(['article', 'fitness'] as const)('publishes %s shares through the common lifecycle and preserves their DTO preview', async kind => {
    const { service, create, post, cache, ranking, sideEffects, realtime } = setup();
    const result = kind === 'article'
      ? await service.createArticleShare({ userId: 'author', body: '  commentary  ', visibility: 'public', articleId: 'article' })
      : await service.createFitnessShare({ userId: 'author', body: '  commentary  ', visibility: 'public', fitnessShareId: 'fitness' });
    expect(create).toHaveBeenCalledWith({
      data: { userId: 'author', body: 'commentary', visibility: 'public', ...(kind === 'article' ? { kind: 'articleShare', articleId: 'article' } : { kind: 'fitnessShare', fitnessShareId: 'fitness' }) },
      include: POST_LIST_INCLUDE,
    });
    expect(sideEffects.dispatch).toHaveBeenCalledWith('post.created', { postId: 'share', actorUserId: 'author', didAwardStreak: false, requestedMarvMode: null }, { jobId: 'post-created-share' });
    expect(cache.bumpForPostWrite).toHaveBeenCalledWith({ topics: [], invalidateFeed: false });
    expect(ranking.enqueueScoreRefresh).toHaveBeenCalledWith('share');
    expect(toPostDto(result, null)).toMatchObject(kind === 'article' ? { kind: 'articleShare', article: { id: 'article', title: 'Article' } } : { kind: 'fitnessShare', fitnessShare: post.fitnessShare });
    expect(kind === 'article' ? result.fitnessShare : result.article).toBeNull();
    expect(realtime.emitGroupNewPost).not.toHaveBeenCalled();
    expect(realtime.emitPostsCommentAdded).not.toHaveBeenCalled();
  });

  it('does not run after-commit work when persistence fails', async () => {
    const { service, create, sideEffects, cache, ranking } = setup();
    create.mockRejectedValueOnce(new Error('failed'));
    await expect(service.createArticleShare({ userId: 'author', body: '', visibility: 'public', articleId: 'article' })).rejects.toThrow('failed');
    expect(sideEffects.dispatch).not.toHaveBeenCalled();
    expect(cache.bumpForPostWrite).not.toHaveBeenCalled();
    expect(ranking.enqueueScoreRefresh).not.toHaveBeenCalled();
  });

  it('rejects abusive shared commentary before storing or dispatching', async () => {
    const { service, create, sideEffects } = setup();
    await expect(service.createArticleShare({ userId: 'author', body: 'I will kill you', visibility: 'public', articleId: 'article' })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(sideEffects.dispatch).not.toHaveBeenCalled();
  });
});
