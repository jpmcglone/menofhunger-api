import {
  EMAIL,
  EMAIL_DARK,
  EMAIL_CLASS,
  emailColorSchemeCss,
  renderMohEmail,
  renderButton,
} from "./moh-email";

describe("moh email color scheme", () => {
  it("declares light+dark and ships both palettes", () => {
    const css = emailColorSchemeCss();
    expect(css).toContain("color-scheme:light dark");
    expect(css).toContain("prefers-color-scheme:dark");
    expect(css).toContain(EMAIL_DARK.page);
    expect(css).toContain(EMAIL_DARK.text);
    expect(css).toContain(`[data-ogsc] .${EMAIL_CLASS.bg}`);
    expect(css).toContain(`[data-ogsb] .${EMAIL_CLASS.bg}`);
    expect(css).not.toMatch(/\[data-ogsc\]\{/);
    expect(css).not.toMatch(/#fff(?:fff)?\b/i);
    expect(css).not.toMatch(/#000(?:000)?\b/i);

    const html = renderMohEmail({
      title: "Test",
      preheader: "Hi",
      contentHtml: "<p>Body</p>",
    });
    expect(html).toContain('content="light dark"');
    expect(html).toContain('name="supported-color-schemes"');
    expect(html).toContain(`bgcolor="${EMAIL.page}"`);
    expect(html).toContain("color-scheme:light dark;");
    expect(html).toContain(`background:${EMAIL.page}`);
    expect(html).toContain(EMAIL_DARK.page);
    expect(html.match(/<style type="text\/css">/g)?.length).toBe(2);
    expect(html).not.toMatch(/#fff(?:fff)?\b/i);
    expect(html).not.toMatch(/#000(?:000)?\b/i);
  });
});

describe("optional email brand navigation", () => {
  it("links the brand only when the caller supplies a destination and escapes that destination", () => {
    const base = {
      title: "Test",
      preheader: "Hello",
      contentHtml: "<p>Body</p>",
    };
    const linked = renderMohEmail({
      ...base,
      brandHref: "https://menofhunger.com/?a=1&b=2",
    });
    expect(linked).toMatch(
      /<a href="https:\/\/menofhunger.com\/\?a=1&amp;b=2"[^>]+>Men of Hunger<\/a>/,
    );
    expect(renderMohEmail(base)).not.toMatch(/<a[^>]+>Men of Hunger<\/a>/);
  });
});

describe("monochrome newsletter button", () => {
  it("uses a dark button and light text inline, and inverts both colors for supported dark-mode clients", () => {
    const button = renderButton({
      href: "https://menofhunger.com/home",
      label: "Open Men of Hunger",
      variant: "monochrome",
      size: "large",
    });
    expect(button).toContain(`class="${EMAIL_CLASS.monochromeButton}"`);
    expect(button).toContain(`background:${EMAIL.text};color:${EMAIL.page};`);
    expect(button).not.toContain(`background:${EMAIL.brass}`);
    expect(button).not.toContain("!important");
    const css = emailColorSchemeCss();
    const darkRule = `background-color:${EMAIL_DARK.text}!important;color:${EMAIL_DARK.page}!important;`;
    expect(css).toContain(
      `.${EMAIL_CLASS.bg} .${EMAIL_CLASS.monochromeButton}{${darkRule}}`,
    );
    expect(css).toContain(
      `[data-ogsc] .${EMAIL_CLASS.monochromeButton}{${darkRule}}`,
    );
    expect(css).toContain(
      `[data-ogsb] .${EMAIL_CLASS.monochromeButton}{${darkRule}}`,
    );
  });
});
