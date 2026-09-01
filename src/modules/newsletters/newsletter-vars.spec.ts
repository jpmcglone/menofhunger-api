import { firstNameFrom } from '../email/email-send.helpers';
import { interpolateTemplate, interpolateTiptapJson, varsForUser } from './newsletter-vars';

describe('newsletter vars', () => {
  it('firstNameFrom uses the first word of name', () => {
    expect(firstNameFrom({ name: 'James Hall', username: 'jh' })).toBe('James');
  });

  it('firstNameFrom falls back to username then there', () => {
    expect(firstNameFrom({ name: '  ', username: 'brother' })).toBe('brother');
    expect(firstNameFrom({ name: null, username: null })).toBe('there');
  });

  it('interpolates known tokens and leaves unknown tokens alone', () => {
    const vars = varsForUser({ name: 'James Hall', username: 'james' });
    expect(interpolateTemplate('Hey {{firstName}}, I am {{name}} (@{{username}})', vars)).toBe(
      'Hey James, I am James Hall (@james)',
    );
    expect(interpolateTemplate('Hi {{unknown}}', vars)).toBe('Hi {{unknown}}');
  });

  it('interpolates TipTap text nodes', () => {
    const json = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hey {{firstName}},' }] }],
    });
    const out = JSON.parse(interpolateTiptapJson(json, varsForUser({ name: 'James Hall', username: 'james' })));
    expect(out.content[0].content[0].text).toBe('Hey James,');
  });
});
