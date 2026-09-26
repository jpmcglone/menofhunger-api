import { toPostDto } from './post.dto';
import type { PostWithAuthorAndMedia } from './post.dto';

const AUTHOR = {
  id: 'author-id', username: 'author', name: 'Author', premium: false, premiumPlus: false, isOrganization: false,
  verifiedStatus: 'identity', avatarKey: null, avatarUpdatedAt: null, bannedAt: null,
};

function boardPost(overrides: Record<string, unknown>): PostWithAuthorAndMedia {
  return {
    id: 'comment-1', createdAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-01'), editedAt: null, editCount: 0,
    body: 'Gonna check it tonight', deletedAt: null, kind: 'board', visibility: 'public', isDraft: false,
    parentId: 'thread-1', rootId: 'thread-1', userId: AUTHOR.id, user: AUTHOR, media: [], mentions: [],
    boostCount: 0, bookmarkCount: 0, commentCount: 0, repostCount: 0, quoteCount: 0, viewerCount: 0,
    topics: [], hashtags: [], cashtags: [], checkinDayKey: null, checkinPrompt: null, communityGroupId: null,
    boardThread: null,
    ...overrides,
  } as unknown as PostWithAuthorAndMedia;
}

describe('Board comment thread title', () => {
  it('names the thread a Board comment belongs to', () => {
    const dto = toPostDto(boardPost({ root: { boardThread: { title: 'Take a stab at building iPhone apps rapidly' } } }), null);
    expect(dto.boardRootId).toBe('thread-1');
    expect(dto.boardThreadTitle).toBe('Take a stab at building iPhone apps rapidly');
  });

  it('trims the title for viewers who cannot read the thread', () => {
    const longTitle = 'Show: I built a tiny app to track my kids chores and it changed our whole house forever';
    const dto = toPostDto(boardPost({ visibility: 'premiumOnly', root: { boardThread: { title: longTitle } } }), null, {
      viewerCanAccess: false,
    });
    expect(dto.boardThreadTitle).not.toBe(longTitle);
    expect(dto.boardThreadTitle?.endsWith('…')).toBe(true);
  });

  it('leaves thread roots and comments without a loaded root unchanged', () => {
    expect(toPostDto(boardPost({ root: null }), null).boardThreadTitle).toBeUndefined();
  });
});
