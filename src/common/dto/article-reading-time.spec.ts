import { estimateReadingTimeMinutes } from './article.dto';

describe('article reading time', () => {
  it('counts nested text while ignoring malformed rich-text nodes', () => {
    const content = Array.from({ length: 400 }, () => 'word').join(' ');
    expect(estimateReadingTimeMinutes(JSON.stringify({ content: [
      null, 42, { type: 'text', text: { invalid: true } },
      { type: 'paragraph', content: [{ type: 'text', text: content }] },
    ] }))).toBe(2);
  });

  it.each(['invalid JSON', 'null', '42', '{}'])('returns the minimum for %s', value => {
    expect(estimateReadingTimeMinutes(value)).toBe(1);
  });
});
