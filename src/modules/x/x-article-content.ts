import { BadRequestException } from "@nestjs/common";

type Node = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: Node[];
};
type Range = { key: number; offset: number; length: number };
type Block = {
  text: string;
  type: string;
  entity_ranges?: Range[];
  inline_style_ranges?: Array<{
    offset: number;
    length: number;
    style: string;
  }>;
};
type Entity = {
  key: string;
  value: { type: string; mutability: string; data: Record<string, unknown> };
};
export type XArticleDraft = {
  title: string;
  content_state: { blocks: Block[]; entities: Entity[] };
  cover_media?: { media_category: string; media_id: string };
};
export type XArticleImage = { url: string; alt: string | null };

/** X OpenAPI ArticleCreateDraftRequest, checked 2026-10-01. Unknown nodes fail explicitly. */
export function xArticleContent(
  title: string,
  body: string,
  imageIds: Map<string, string> = new Map(),
): { draft: XArticleDraft; images: XArticleImage[] } {
  let doc: Node;
  try {
    doc = JSON.parse(body) as Node;
  } catch {
    throw new BadRequestException("The article body could not be read.");
  }
  if (doc?.type !== "doc" || !Array.isArray(doc.content) || !title.trim())
    throw new BadRequestException("The article needs a title and body.");
  const blocks: Block[] = [];
  const entities: Entity[] = [];
  const images: XArticleImage[] = [];
  let visited = 0;
  const fail = (type: string): never => {
    throw new BadRequestException(
      `X Articles cannot preserve ${type} yet. Choose a link or edit the article.`,
    );
  };
  const entity = (
    type: string,
    data: Record<string, unknown>,
    mutable = false,
  ): number => {
    const key = entities.length;
    entities.push({
      key: String(key),
      value: { type, mutability: mutable ? "mutable" : "immutable", data },
    });
    return key;
  };
  const url = (raw: unknown) => {
    try {
      const parsed = new URL(String(raw));
      if (
        !["https:", "http:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        return fail("this URL");
      return parsed.toString();
    } catch {
      return fail("this URL");
    }
  };
  function inline(node: Node, block: Block) {
    if (++visited > 20_000) fail("this much content");
    if (node.type === "hardBreak") {
      block.text += "\n";
      return;
    }
    if (node.type !== "text" || typeof node.text !== "string") fail(node.type);
    const offset = block.text.length;
    block.text += node.text;
    for (const mark of node.marks ?? []) {
      if (mark.type === "link")
        (block.entity_ranges ??= []).push({
          key: entity("link", { url: url(mark.attrs?.href) }, true),
          offset,
          length: (node.text ?? "").length,
        });
      else {
        const style = (
          { bold: "bold", italic: "italic", strike: "strikethrough" } as Record<
            string,
            string
          >
        )[mark.type];
        if (!style) fail(`${mark.type} formatting`);
        (block.inline_style_ranges ??= []).push({
          offset,
          length: (node.text ?? "").length,
          style,
        });
      }
    }
  }
  function walk(node: Node, list?: string) {
    if (++visited > 20_000) fail("this much content");
    const atomic = (type: string, data: Record<string, unknown>, text = " ") =>
      blocks.push({
        text,
        type: "atomic",
        entity_ranges: [
          {
            key: entity(type, data, type === "markdown"),
            offset: 0,
            length: text.length,
          },
        ],
      });
    if (node.type === "paragraph" || node.type === "heading") {
      const headings = ["header-one", "header-two", "header-three"];
      const heading = headings[Number(node.attrs?.level) - 1];
      if (node.type === "heading" && !heading) fail("this heading level");
      const block: Block = {
        text: "",
        type: list ?? (node.type === "heading" ? heading! : "unstyled"),
      };
      (node.content ?? []).forEach((child) => inline(child, block));
      blocks.push(block);
      return;
    }
    if (node.type === "bulletList" || node.type === "orderedList") {
      if (
        list ||
        (node.type === "orderedList" &&
          node.attrs?.start &&
          node.attrs.start !== 1)
      )
        fail("nested or custom-numbered lists");
      for (const child of node.content ?? []) {
        if (child.type !== "listItem" || child.content?.length !== 1)
          fail("this list");
        walk(
          child.content![0]!,
          node.type === "bulletList"
            ? "unordered-list-item"
            : "ordered-list-item",
        );
      }
      return;
    }
    if (node.type === "blockquote") {
      (node.content ?? []).forEach((child) => walk(child, "blockquote"));
      return;
    }
    if (node.type === "horizontalRule") {
      atomic("divider", {});
      return;
    }
    if (node.type === "codeBlock") {
      const text = (node.content ?? [])
        .map((child) => {
          if (child.type !== "text" || child.marks?.length)
            return fail("this code block");
          return child.text ?? "";
        })
        .join("");
      if (
        text.includes("```") ||
        !/^[a-z0-9_-]*$/i.test(String(node.attrs?.language ?? ""))
      )
        fail("this code block");
      atomic("markdown", {
        markdown: `\`\`\`${node.attrs?.language ?? ""}\n${text}\n\`\`\``,
      });
      return;
    }
    if (node.type === "image") {
      const src = url(node.attrs?.src);
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : null;
      if ((alt?.length ?? 0) > 1000)
        fail("photo alt text longer than 1,000 characters");
      if (!images.some((image) => image.url === src))
        images.push({ url: src, alt });
      atomic("image", {
        media_items: [
          {
            media_category: "tweet_image",
            media_id: imageIds.get(src) ?? "pending-upload",
          },
        ],
        ...(node.attrs?.title ? { caption: String(node.attrs.title) } : {}),
      });
      return;
    }
    fail(node.type);
  }
  doc.content.forEach((node) => walk(node));
  if (!blocks.length || images.length > 20)
    fail("an empty body or more than 20 images");
  return {
    draft: { title: title.trim(), content_state: { blocks, entities } },
    images,
  };
}
