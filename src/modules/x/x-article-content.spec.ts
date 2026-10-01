import { xArticleContent } from "./x-article-content";
const body = (content: unknown[]) => JSON.stringify({ type: "doc", content });
describe("native X Article conversion", () => {
  it("preserves Unicode offsets, supported formatting and link targets", () => {
    const result = xArticleContent(
      "Title",
      body([
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hi 🦁 " },
            {
              type: "text",
              text: "read",
              marks: [
                { type: "bold" },
                { type: "link", attrs: { href: "https://example.com/story" } },
              ],
            },
          ],
        },
      ]),
    ).draft;
    expect(result.content_state.blocks[0]).toEqual({
      type: "unstyled",
      text: "Hi 🦁 read",
      inline_style_ranges: [{ offset: 6, length: 4, style: "bold" }],
      entity_ranges: [{ key: 0, offset: 6, length: 4 }],
    });
    expect(result.content_state.entities[0]?.value.data.url).toBe(
      "https://example.com/story",
    );
  });
  it("retains image accessibility text and replaces source URLs with uploaded media IDs", () => {
    const source = body([
      {
        type: "image",
        attrs: {
          src: "https://media.example.com/photo.jpg",
          alt: "A mountain",
        },
      },
    ]);
    const result = xArticleContent(
      "Title",
      source,
      new Map([["https://media.example.com/photo.jpg", "123"]]),
    );
    expect(result.images).toEqual([
      { url: "https://media.example.com/photo.jpg", alt: "A mountain" },
    ]);
    expect(
      result.draft.content_state.entities[0]?.value.data.media_items,
    ).toEqual([{ media_category: "tweet_image", media_id: "123" }]);
  });
  it.each(["youtube", "unknown", "callout"])(
    "refuses silent removal of %s",
    (type) => {
      expect(() => xArticleContent("Title", body([{ type }]))).toThrow(
        "cannot preserve",
      );
    },
  );
  it("refuses unsafe link targets and unsupported inline formatting", () => {
    for (const mark of [
      { type: "link", attrs: { href: "javascript:alert(1)" } },
      { type: "underline" },
    ]) {
      expect(() =>
        xArticleContent(
          "Title",
          body([
            {
              type: "paragraph",
              content: [{ type: "text", text: "text", marks: [mark] }],
            },
          ]),
        ),
      ).toThrow();
    }
  });
});
