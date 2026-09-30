import { selectFreshForYou } from './for-you-freshness';

const row = (id: string, userId = id) => ({ candidate: { id, userId, parentId: null } });
const at = (hours: number) => ({ lastSeenAt: new Date(hours * 3_600_000) });
const select = (ranked: ReturnType<typeof row>[], seen: [string, ReturnType<typeof at>][], limit = 5, updated: string[] = []) =>
  selectFreshForYou(ranked, { limit, seenById: new Map(seen), hasNewReplies: id => updated.includes(id), authorWindow: 5 }).map(r => r.candidate.id);

describe('For You freshness tiers', () => {
  it('puts an unseen post ahead of the highest-ranked seen board on reload and refresh', () => {
    expect(select([row('board'), row('fresh')], [['board', at(10)]], 1)).toEqual(['fresh']);
  });
  it('exhausts unseen posts before repeats even if they share an author', () => {
    expect(select([row('repeat'), row('a', 'same'), row('b', 'same')], [['repeat', at(10)]], 2)).toEqual(['a', 'b']);
  });
  it('allows at most two meaningful updates after unseen posts, before unchanged repeats', () => {
    const ids = ['old', 'updated1', 'updated2', 'updated3', 'unseen'];
    expect(select(ids.map(id => row(id)), ids.slice(0, 4).map(id => [id, at(10)]), 5, ids.slice(1, 4)))
      .toEqual(['unseen', 'updated1', 'updated2', 'old']);
  });
  it('fills exhausted feeds with the least recently seen repeats and preserves seeded order within an hour', () => {
    expect(select([row('just-seen'), row('old-b'), row('old-a')], [['just-seen', at(12)], ['old-b', at(1)], ['old-a', at(1)]]))
      .toEqual(['old-b', 'old-a', 'just-seen']);
  });
  it('does not duplicate candidates while relaxing author diversity', () => {
    expect(select([row('a'), row('a'), row('b')], [], 3)).toEqual(['a', 'b']);
  });
});
