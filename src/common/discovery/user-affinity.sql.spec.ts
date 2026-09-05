import { topicPhrasePairCount, topicPhrasesCteSql } from './user-affinity.sql';

describe('user-affinity SQL helpers', () => {
  it('builds a topic-phrase list from the allowlist', () => {
    expect(topicPhrasePairCount()).toBeGreaterThan(100);
    const sql = topicPhrasesCteSql() as { strings?: readonly string[] };
    const text = (sql.strings ?? []).join(' ');
    expect(text).toContain('topic_phrases');
    expect(text).toContain('VALUES');
  });
});
