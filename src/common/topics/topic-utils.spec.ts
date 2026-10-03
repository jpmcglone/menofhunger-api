import { parseModelTopicList, queryToTopicValues, inferTopicsFromText } from './topic-utils';

describe('parseModelTopicList', () => {
  it('canonicalizes allowlisted values and drops unknown tokens', () => {
    expect(parseModelTopicList('["Faith", "not-a-topic", "bible"]')).toEqual(['faith', 'bible']);
  });

  it('extracts a JSON array from surrounding prose', () => {
    expect(parseModelTopicList('Topics: ["prayer","bible"]')).toEqual(['bible', 'prayer']);
  });

  it('returns empty when the model has nothing to say', () => {
    expect(parseModelTopicList('none')).toEqual([]);
    expect(parseModelTopicList('[]')).toEqual([]);
  });
});


describe('gaming search vocabulary', () => {
  it.each(['game', 'games', 'gaming', 'gamer', 'gamers'])('maps %s to stored gaming topics', (query) => {
    expect(queryToTopicValues(query)).toContain('gaming');
  });

  it('does not broaden unrelated words or tag incidental game wording', () => {
    expect(queryToTopicValues('gameplan')).not.toContain('gaming');
    expect(inferTopicsFromText('That is the game of politics.')).not.toContain('gaming');
  });
});
