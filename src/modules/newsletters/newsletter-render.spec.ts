import { renderNewsletterEmail } from "./newsletter-render";

describe("newsletter render", () => {
  const rendered = renderNewsletterEmail({
    subject: "Hello {{firstName}}",
    preheader: "",
    bodyJson: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hey {{firstName}}, welcome." }],
        },
      ],
    }),
    ctaLabel: "Open the lodge",
    ctaHref: "https://menofhunger.com/home",
    vars: { firstName: "James", name: "James Hall", username: "james" },
    unsubscribeUrl: "https://menofhunger.com/email/unsubscribe?token=abc",
    settingsUrl: "https://menofhunger.com/settings/notifications",
    postalAddress: "123 Main St, Roanoke, VA",
  });

  it("interpolates the subject and wraps the MOH email shell", () => {
    expect(rendered.subject).toBe("Hello James");
    expect(rendered.html).toContain("Men of Hunger");
    expect(rendered.html).toContain("Hey James, welcome.");
    expect(rendered.html).toContain("Open the lodge");
    expect(rendered.html).toContain("Unsubscribe from newsletters");
    expect(rendered.html).toContain("123 Main St, Roanoke, VA");
    expect(rendered.html).toContain("color-scheme");
    expect(rendered.html).toContain("light dark");
    expect(rendered.html).toContain("#FBFAF7");
    expect(rendered.html).toContain("#0F1113");
    expect(rendered.html).toContain("prefers-color-scheme:dark");
    expect(rendered.html).toContain("[data-ogsc]");
    expect(rendered.html).toContain("[data-ogsb]");
    expect(rendered.html).toContain("Inter");
  });

  it("includes a plain-text unsubscribe path", () => {
    expect(rendered.text).toContain(
      "Unsubscribe from newsletters: https://menofhunger.com/email/unsubscribe?token=abc",
    );
  });

  it("autolinks usernames and scripture in the body", () => {
    const linked = renderNewsletterEmail({
      subject: "Look",
      preheader: "",
      bodyJson: JSON.stringify({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Ask @james about John 3:16 and #lodge." },
            ],
          },
        ],
      }),
      vars: { firstName: "James", name: "James Hall", username: "james" },
      unsubscribeUrl: "https://menofhunger.com/email/unsubscribe?token=abc",
      settingsUrl: "https://menofhunger.com/settings/notifications",
      postalAddress: "123 Main St, Roanoke, VA",
      siteUrl: "https://menofhunger.com",
    });
    expect(linked.html).toContain("https://menofhunger.com/u/james");
    expect(linked.html).toContain(
      "https://menofhunger.com/explore?q=John%203%3A16",
    );
    expect(linked.html).toContain("https://menofhunger.com/explore?q=%23lodge");
  });

  it("renders hero and inline body images", () => {
    const withImages = renderNewsletterEmail({
      subject: "Look",
      preheader: "",
      bodyJson: JSON.stringify({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "A photo:" }] },
          {
            type: "image",
            attrs: { src: "https://cdn.example.com/inline.jpg", alt: "Lodge" },
          },
        ],
      }),
      heroImageUrl: "https://cdn.example.com/hero.jpg",
      vars: { firstName: "James", name: "James Hall", username: "james" },
      unsubscribeUrl: "https://menofhunger.com/email/unsubscribe?token=abc",
      settingsUrl: "https://menofhunger.com/settings/notifications",
      postalAddress: "123 Main St, Roanoke, VA",
    });
    expect(withImages.html).toContain("https://cdn.example.com/hero.jpg");
    expect(withImages.html).toContain("https://cdn.example.com/inline.jpg");
    expect(withImages.html).toContain('alt="Lodge"');
  });
});

describe("newsletter navigation", () => {
  const input = {
    subject: "A letter from Men of Hunger",
    preheader: "",
    bodyJson: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello James." }],
        },
      ],
    }),
    vars: { firstName: "James", name: "James Hall", username: "james" },
    unsubscribeUrl: "https://menofhunger.com/email/unsubscribe?token=sample",
    settingsUrl: "https://menofhunger.com/settings/notifications",
    postalAddress: "Example mailing address",
  };

  it("always supplies a brand link, default feed button and site footer in HTML and plain text", () => {
    const result = renderNewsletterEmail(input);
    expect(result.html).toMatch(
      /<a href="https:\/\/menofhunger.com"[^>]+>Men of Hunger<\/a>/,
    );
    expect(result.html).toMatch(
      /<a href="https:\/\/menofhunger.com\/home"[^>]+>Open Men of Hunger<\/a>/,
    );
    expect(result.html).toMatch(
      /<a href="https:\/\/menofhunger.com"[^>]+>Visit Men of Hunger<\/a>/,
    );
    expect(result.html).toContain("padding:12px 16px;line-height:24px;");
    expect(result.html).toContain('class="moh-button-monochrome"');
    expect(result.text).toContain(
      "Open Men of Hunger: https://menofhunger.com/home",
    );
    expect(result.text).toContain(
      "Visit Men of Hunger: https://menofhunger.com",
    );
    expect(result.html).toContain("Unsubscribe from newsletters");
    expect(result.text).toContain(input.unsubscribeUrl);
    expect(result.text).toContain(input.settingsUrl);
  });

  it("preserves an external custom CTA and still provides permanent site navigation", () => {
    const result = renderNewsletterEmail({
      ...input,
      ctaLabel: "See the event",
      ctaHref: "https://example.com/event?a=1&b=2",
    });
    expect(result.html).toContain(
      'href="https://example.com/event?a=1&amp;b=2"',
    );
    expect(result.html).not.toContain("Open Men of Hunger");
    expect(result.html).toContain("Visit Men of Hunger");
    expect(result.text).toContain(
      "See the event: https://example.com/event?a=1&b=2",
    );
    expect(result.text).toContain(
      "Visit Men of Hunger: https://menofhunger.com",
    );
  });

  it.each(["mailto:hello@menofhunger.com", "tel:+15555550100"])(
    "preserves a custom contact CTA: %s",
    (ctaHref) => {
      const result = renderNewsletterEmail({
        ...input,
        ctaLabel: "Get in touch",
        ctaHref,
      });
      expect(result.text).toContain(`Get in touch: ${ctaHref}`);
      expect(result.text).toContain(
        "Visit Men of Hunger: https://menofhunger.com",
      );
    },
  );

  it.each([
    { ctaLabel: "Custom only" },
    { ctaHref: "/home" },
    { ctaLabel: "Unsafe", ctaHref: "javascript:alert(1)" },
    { ctaLabel: "Empty", ctaHref: "   " },
  ])("uses the safe default for incomplete or unsafe CTA input: %j", (cta) => {
    const result = renderNewsletterEmail({ ...input, ...cta });
    expect(result.html).toContain(">Open Men of Hunger</a>");
    expect(result.html).not.toContain("javascript:");
  });

  it("uses the configured origin for previews and resolves relative custom links", () => {
    const result = renderNewsletterEmail({
      ...input,
      siteUrl: "https://preview.example.com/",
      ctaLabel: "Read the post",
      ctaHref: "/p/sample",
    });
    expect(result.html).toContain('href="https://preview.example.com"');
    expect(result.text).toContain(
      "Read the post: https://preview.example.com/p/sample",
    );
    expect(result.text).toContain(
      "Visit Men of Hunger: https://preview.example.com",
    );
  });
});
