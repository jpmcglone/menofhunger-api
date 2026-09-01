import { EMAIL, EMAIL_DARK, EMAIL_CLASS, emailColorSchemeCss, renderMohEmail } from './moh-email';

describe('moh email color scheme', () => {
  it('declares light+dark and ships both palettes', () => {
    const css = emailColorSchemeCss();
    expect(css).toContain('color-scheme:light dark');
    expect(css).toContain('prefers-color-scheme:dark');
    expect(css).toContain(EMAIL_DARK.page);
    expect(css).toContain(EMAIL_DARK.text);
    expect(css).toContain(`[data-ogsc] .${EMAIL_CLASS.bg}`);
    expect(css).toContain(`[data-ogsb] .${EMAIL_CLASS.bg}`);
    expect(css).not.toMatch(/\[data-ogsc\]\{/);
    expect(css).not.toMatch(/#fff(?:fff)?\b/i);
    expect(css).not.toMatch(/#000(?:000)?\b/i);

    const html = renderMohEmail({
      title: 'Test',
      preheader: 'Hi',
      contentHtml: '<p>Body</p>',
    });
    expect(html).toContain('content="light dark"');
    expect(html).toContain('name="supported-color-schemes"');
    expect(html).toContain(`bgcolor="${EMAIL.page}"`);
    expect(html).toContain('color-scheme:light dark;');
    expect(html).toContain(`background:${EMAIL.page}`);
    expect(html).toContain(EMAIL_DARK.page);
    expect(html.match(/<style type="text\/css">/g)?.length).toBe(2);
    expect(html).not.toMatch(/#fff(?:fff)?\b/i);
    expect(html).not.toMatch(/#000(?:000)?\b/i);
  });
});
