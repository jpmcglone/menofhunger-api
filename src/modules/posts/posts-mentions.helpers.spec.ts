import { excludeMarvFromParticipants, excludeMarvUserId } from './posts-mentions.helpers';

describe('excludeMarvFromParticipants', () => {
  const people = [
    { id: 'alice', username: 'alice' },
    { id: 'marv-id', username: 'marv' },
    { id: 'bob', username: 'bob' },
  ];

  it('drops Marv by user id or username', () => {
    expect(excludeMarvFromParticipants(people, { userId: 'marv-id', username: 'marv' }).map((p) => p.id)).toEqual([
      'alice',
      'bob',
    ]);
    expect(excludeMarvFromParticipants(people, { userId: null, username: 'MARV' }).map((p) => p.id)).toEqual([
      'alice',
      'bob',
    ]);
  });
});

describe('excludeMarvUserId', () => {
  it('removes the Marv id when known', () => {
    expect(excludeMarvUserId(['alice', 'marv-id', 'bob'], 'marv-id')).toEqual(['alice', 'bob']);
  });

  it('leaves the list alone when Marv is not resolved', () => {
    expect(excludeMarvUserId(['alice', 'marv-id'], null)).toEqual(['alice', 'marv-id']);
  });
});
