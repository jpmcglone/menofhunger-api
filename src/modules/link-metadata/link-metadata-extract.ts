import { readLimitedResponse } from "../../common/http/read-limited-response";
import { Prisma } from "@prisma/client";
import { isPickaxGatedMarkdown, isWeakPickaxImage, parsePickaxAuthorFromJina, parsePickaxBodyFromJina, pickaxAuthorFromTitle } from "./pickax-link-metadata";
import { type SocialPostMetadataDto } from "./x-link-metadata";
import { type VideoEmbedDto } from "./rumble-link-metadata";
import { normalizeText, type LinkMetadataDto } from './link-metadata.constants';
import { fromJsonValue } from '../../common/prisma/json';

export function toDto(row: {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  socialPost: Prisma.JsonValue;
  videoEmbed?: Prisma.JsonValue;
}): LinkMetadataDto {
  return {
    url: row.url,
    title: normalizeText(row.title),
    description: normalizeText(row.description),
    imageUrl: normalizeText(row.imageUrl),
    siteName: normalizeText(row.siteName),
    socialPost:
      row.socialPost &&
      typeof row.socialPost === "object" &&
      !Array.isArray(row.socialPost)
        ? fromJsonValue<SocialPostMetadataDto>(row.socialPost)
        : null,
    videoEmbed:
      row.videoEmbed &&
      typeof row.videoEmbed === "object" &&
      !Array.isArray(row.videoEmbed)
        ? fromJsonValue<VideoEmbedDto>(row.videoEmbed)
        : null,
  };
}

export async function enrichPickaxPost(
  url: string,
  base: LinkMetadataDto | null,
  signal: AbortSignal,
): Promise<LinkMetadataDto | null> {
  try {
    const proxied = `https://r.jina.ai/${url}`;
    const res = await fetch(proxied, { method: "GET", signal });
    if (!res.ok) return null;
    const md = (await readLimitedResponse(res, 1_048_576)).toString("utf8");
    if (isPickaxGatedMarkdown(md)) return null;
    const titleMatch = (md ?? "").toString().match(/^\s*Title:\s*(.+)\s*$/m);
    const titleFromJina = normalizeText(titleMatch?.[1] ?? null);
    const { avatarUrl, username } = parsePickaxAuthorFromJina(md);
    const authorName =
      pickaxAuthorFromTitle(titleFromJina) ??
      pickaxAuthorFromTitle(base?.title) ??
      normalizeText(username);
    const bodyFromJina = parsePickaxBodyFromJina(md);

    return {
      url,
      title: authorName,
      // Prefer the scraped body; OG/microlink descriptions are often truncated.
      description: bodyFromJina ?? base?.description ?? null,
      // Prefer @handle in siteName so clients can render a post-like subtitle.
      siteName: username ? `@${username}` : "Pickax",
      imageUrl:
        avatarUrl ??
        (isWeakPickaxImage(base?.imageUrl) ? null : (base?.imageUrl ?? null)),
      socialPost: null,
      videoEmbed: null,
    };
  } catch {
    return null;
  }
}

/** Extracts links from post body text (for cron backfill). Uses same logic as www extractLinksFromText. */
export function extractLinks(text: string): string[] {
  const input = (text ?? "").toString();
  const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
  const matches = input.match(urlPattern) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const url = (m ?? "").trim();
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        continue;
      const norm = parsed.toString();
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
    } catch {
      // skip invalid URLs
    }
  }
  return out;
}
