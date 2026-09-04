import { parseModelTopicList } from './topic-utils';

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
