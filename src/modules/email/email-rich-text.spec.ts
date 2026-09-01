import { linkifyEmailText } from './email-rich-text';

const SITE = 'https://menofhunger.com';

describe('linkifyEmailText', () => {
  it('links usernames, hashtags, cashtags, urls, and scripture', () => {
    const html = linkifyEmailText(
      'Hey @james see #lodge and $AAPL plus John 3:16 at https://menofhunger.com/home',
      SITE,
    );
    expect(html).toContain('href="https://menofhunger.com/u/james"');
    expect(html).toContain('href="https://menofhunger.com/explore?q=%23lodge"');
    expect(html).toContain('href="https://menofhunger.com/explore?q=%24AAPL"');
    expect(html).toContain('href="https://menofhunger.com/explore?q=John%203%3A16"');
    expect(html).toContain('href="https://menofhunger.com/home"');
    expect(html).toContain('>@james<');
    expect(html).toContain('>John 3:16<');
  });

  it('does not treat emails as mentions', () => {
    const html = linkifyEmailText('write foo@bar.com', SITE);
    expect(html).not.toContain('/u/bar');
    expect(html).toContain('foo@bar.com');
  });

  it('escapes when no site url is provided', () => {
    expect(linkifyEmailText('<b>@james</b>', '')).toBe('&lt;b&gt;@james&lt;/b&gt;');
  });
});
