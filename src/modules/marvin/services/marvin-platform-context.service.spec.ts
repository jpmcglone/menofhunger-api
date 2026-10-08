import { marvChannelSourceWhere } from '../../group-channels/channel-marv-scope.service';
import { MARV_PUBLIC_KNOWLEDGE } from '../marvin-prompt-instructions';
import { MarvinPlatformContextService, renderMarvPlatformBriefing } from './marvin-platform-context.service';

function prismaMock(): any {
  return {
    post: { findMany: jest.fn(async () => []) },
    article: { findMany: jest.fn(async () => []) },
    communityGroup: { findFirst: jest.fn(async () => null) },
    message: { findMany: jest.fn(async () => []) },
  };
}

describe('MarvinPlatformContextService', () => {
  it('loads public posts, articles, and the Board, and does not read channels outside a group', async () => {
    const prisma = prismaMock();
    const service = new MarvinPlatformContextService(prisma as never);
    const note = await service.briefing();
    expect(note).toContain(MARV_PUBLIC_KNOWLEDGE);
    expect(note).toContain('Public posts:');
    expect(note).toContain('Published articles:');
    expect(note).toContain('Board:');
    expect(note).not.toContain('This group');
    expect(prisma.message.findMany).not.toHaveBeenCalled();

    const postWheres = prisma.post.findMany.mock.calls.map((call: any) => call[0].where);
    expect(postWheres).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ communityGroupId: null, visibility: 'public', kind: { not: 'board' } }),
        expect.objectContaining({ communityGroupId: null, visibility: 'public', kind: 'board' }),
      ]),
    );
    expect(prisma.article.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          isDraft: false,
          visibility: 'public',
          publishedAt: { not: null },
        }),
      }),
    );
  });

  it('adds the current group feed and normal channels, and leaves the current channel to its own history', async () => {
    const prisma = prismaMock();
    prisma.communityGroup.findFirst.mockResolvedValue({ name: 'tesr' });
    const service = new MarvinPlatformContextService(prisma as never);
    const note = await service.briefing({ groupId: 'g1', channelId: 'general', privateChannel: false });
    expect(note).toContain('This group "tesr"');
    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          communityGroupId: 'g1',
          parentId: null,
          visibility: { not: 'onlyMe' },
        }),
      }),
    );
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          conversation: {
            groupChannel: {
              ...marvChannelSourceWhere('g1', 'general', false),
              archivedAt: null,
              NOT: { id: 'general' },
            },
          },
        }),
      }),
    );
  });

  it('keeps a private channel out of every other reply, including a sibling channel in the same group', async () => {
    const prisma = prismaMock();
    prisma.communityGroup.findFirst.mockResolvedValue({ name: 'tesr' });
    const service = new MarvinPlatformContextService(prisma as never);
    await service.briefing({ groupId: 'g1', channelId: 'secret', privateChannel: true });
    const where = prisma.message.findMany.mock.calls[0][0].where.conversation.groupChannel;
    expect(where).toEqual({
      ...marvChannelSourceWhere('g1', 'secret', true),
      archivedAt: null,
      NOT: { id: 'secret' },
    });
    expect(where.OR).toEqual([{ privacy: 'normal' }, { id: 'secret', privacy: 'private' }]);

    prisma.message.findMany.mockClear();
    await service.searchChannels({ groupId: 'g1', privateChannel: false }, 'hunger');
    const searched = prisma.message.findMany.mock.calls[0][0].where.conversation.groupChannel;
    expect(searched).toEqual({ ...marvChannelSourceWhere('g1', 'none', false), archivedAt: null });
    expect(searched.OR).toEqual([{ privacy: 'normal' }]);
  });

  it('does not read a deleted group, and a failed load still forbids claiming ignorance', async () => {
    const prisma = prismaMock();
    const service = new MarvinPlatformContextService(prisma as never);
    await service.briefing({ groupId: 'gone' });
    expect(prisma.message.findMany).not.toHaveBeenCalled();

    prisma.post.findMany.mockRejectedValue(new Error('db down'));
    const note = await service.briefing();
    expect(note).toContain('Never say you do not know');
    expect(note).toContain('list_public_posts');
  });
});

describe('renderMarvPlatformBriefing', () => {
  it('names the public record and the group the question was asked in', () => {
    const note = renderMarvPlatformBriefing({
      posts: [{ author: 'ada', createdAt: new Date('2026-10-08T12:00:00Z'), body: 'Morning check-in' }],
      articles: [{ author: 'ben', publishedAt: new Date('2026-10-07T12:00:00Z'), title: 'On fasting', excerpt: 'A short piece' }],
      board: [{ author: 'cam', createdAt: new Date('2026-10-08T08:00:00Z'), title: 'A link', body: 'Worth reading' }],
      group: {
        name: 'tesr',
        posts: [{ author: 'marv', createdAt: new Date('2026-10-08T13:00:00Z'), body: 'I don’t know.' }],
        messages: [{ channel: 'general', author: 'jpmcglone', createdAt: new Date('2026-10-08T13:37:00Z'), body: 'what’s new today' }],
      },
    });
    expect(note).toContain('@ada (2026-10-08): Morning check-in');
    expect(note).toContain('@ben (2026-10-07): On fasting');
    expect(note).toContain('Board:');
    expect(note).toContain('#general @jpmcglone');
    expect(note).toContain('private channel');
  });
});
