import { parseMentionsFromBody } from '../src/common/mentions/mention-regex';

describe('mention-regex (parseMentionsFromBody)', () => {
  it('parses @username tokens (email-safe)', () => {
    expect(parseMentionsFromBody('Hello @John')).toEqual(['John']);
    expect(parseMentionsFromBody('email foo@bar.com and mention @jane')).toEqual(['jane']);
  });

  it('dedupes exact duplicates', () => {
    expect(parseMentionsFromBody('@john @john')).toEqual(['john']);
  });
});

