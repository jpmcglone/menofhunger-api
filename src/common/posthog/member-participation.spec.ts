import { captureMemberParticipation } from './member-participation';
const post = { id: 'p1', userId: 'author', kind: 'regular', visibility: 'public', isBot: false, verifiedStatus: 'manual' };
it.each([{ isBot: true }, { visibility: 'onlyMe' }, { kind: 'repost' }, { verifiedStatus: 'none' }])('excludes non-member participation %j', patch => {
  const capture = jest.fn(); captureMemberParticipation({ capture }, { ...post, ...patch }); expect(capture).not.toHaveBeenCalled();
});
it('records a human reply for the receiver using their identity and stable deduplication keys', () => {
  const capture = jest.fn(); captureMemberParticipation({ capture }, { ...post, parentId: 'p0', parentAuthorId: 'recipient', parentIsBot: false });
  expect(capture.mock.calls.map(call => call.slice(0, 2))).toEqual([['author', 'member_contributed'], ['author', 'member_replied'], ['recipient', 'member_received_reply']]);
  expect(capture.mock.calls[2][2]).toEqual({ $insert_id: 'received-reply:p1' });
});
it.each([{ parentAuthorId: 'author' }, { parentAuthorId: 'bot', parentIsBot: true }])('excludes self-replies and bot conversations from human connection %j', patch => {
  const capture = jest.fn(); captureMemberParticipation({ capture }, { ...post, parentId: 'p0', ...patch }); expect(capture).toHaveBeenCalledTimes(1);
});
