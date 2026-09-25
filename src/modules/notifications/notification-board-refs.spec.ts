import { boardNotificationRefs } from './notification-query.service';
import { notificationFilterWhere } from './notification-category';

describe('Board notification refs', () => {
  it('routes a comment notification to the thread and the new comment', () => {
    const refs = boardNotificationRefs(
      { id: 'c2', parentId: 'c1', kind: 'board', rootId: 'thread' },
      { id: 'c1', parentId: 'thread', kind: 'board', rootId: 'thread' },
    );
    expect(refs).toEqual({ boardThreadId: 'thread', boardCommentId: 'c2' });
  });

  it('routes a boost on a thread to the thread with no comment focus', () => {
    expect(boardNotificationRefs(null, { id: 'thread', parentId: null, kind: 'board', rootId: null }))
      .toEqual({ boardThreadId: 'thread', boardCommentId: null });
  });

  it('leaves regular post notifications untouched', () => {
    expect(boardNotificationRefs({ id: 'p', parentId: null, kind: 'regular', rootId: null }, null)).toEqual({});
  });

  it('filters the inbox to Board activity by causing or subject post', () => {
    expect(notificationFilterWhere('board')).toEqual({
      OR: [{ actorPost: { is: { kind: 'board' } } }, { subjectPost: { is: { kind: 'board' } } }],
    });
  });
});
