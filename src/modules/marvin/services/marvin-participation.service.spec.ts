import { MarvinParticipationService } from './marvin-participation.service';

describe('participation suggestions', () => {
  it('ranks followed and shared-interest authors, diversifies authors, and queries only eligible public posts', async () => {
    const post = (id: string, userId: string, interests: string[] = [], replies = 0) => ({ id, userId, body: id, user: { username: userId, name: null, interests }, _count: { replies } });
    const prisma: any = {
      user: { findUnique: jest.fn(async () => ({ interests: ['Running'] })) },
      follow: { findMany: jest.fn(async () => [{ followingId: 'friend' }]) },
      post: { findMany: jest.fn(async () => [post('recent', 'stranger'), post('shared', 'runner', ['running']), post('followed', 'friend'), post('duplicate', 'friend')]) },
    };
    const result = await new MarvinParticipationService(prisma).suggestions('me', 'focal');
    expect(result.suggestions.map(p => p.postId)).toEqual(['followed', 'shared', 'recent']);
    expect(result.suggestions[1].reason).toBe('Shared interest: running');
    const { where, take } = prisma.post.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ visibility: 'public', communityGroupId: null, isDraft: false, deletedAt: null, userId: { not: 'me' }, id: { not: 'focal' }, replies: { none: { userId: 'me' } } });
    expect(where.user).toMatchObject({ bannedAt: null, isBot: false, blocksInitiated: { none: { blockedId: 'me' } }, blocksReceived: { none: { blockerId: 'me' } } });
    expect(take).toBeLessThanOrEqual(60);
  });
});
