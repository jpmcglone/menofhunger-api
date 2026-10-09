import { Logger } from "@nestjs/common";
import { readLimitedResponse } from "../../common/http/read-limited-response";
import { spotifyContent, fetchSpotifyMetadata } from "./spotify-link-metadata";
import {
  isPickaxPostUrl,
  isWeakPickaxImage,
  pickaxAuthorFromTitle,
} from "./pickax-link-metadata";
import {
  isXPostUrl,
  parseXSyndicationResponse,
  parseXPostUrl,
  xSyndicationToken,
} from "./x-link-metadata";
import { isRumbleVideoUrl, enrichRumbleVideo } from "./rumble-link-metadata";
import {
  isSubstackPostUrl,
  enrichSubstackPost,
} from "./substack-link-metadata";
import { fetchYoutubeMetadata, youtubeVideoId } from "./youtube-link-metadata";
import {
  FETCH_TIMEOUT_MS,
  normalizeText,
  PICKAX_ENRICH_TIMEOUT_MS,
  X_ENRICH_TIMEOUT_MS,
  SUBSTACK_ENRICH_TIMEOUT_MS,
  RUMBLE_ENRICH_TIMEOUT_MS,
  type LinkMetadataDto,
  type MicrolinkResponse,
} from "./link-metadata.constants";
import { enrichPickaxPost } from "./link-metadata-extract";
const logger = new Logger("LinkMetadataFetch");

export async function fetchFromExternal(
  url: string,
): Promise<LinkMetadataDto | null> {
  const controller = new AbortController();
  const timeoutMs =
    youtubeVideoId(url) || spotifyContent(url)
      ? 4_000
      : isPickaxPostUrl(url)
        ? PICKAX_ENRICH_TIMEOUT_MS
        : isXPostUrl(url)
          ? X_ENRICH_TIMEOUT_MS
          : isSubstackPostUrl(url)
            ? SUBSTACK_ENRICH_TIMEOUT_MS
            : isRumbleVideoUrl(url)
              ? RUMBLE_ENRICH_TIMEOUT_MS
              : FETCH_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;

    if (spotifyContent(url)) {
      const meta = await fetchSpotifyMetadata(url, controller.signal);
      return meta ? { url, ...meta, socialPost: null, videoEmbed: null } : null;
    }

    if (youtubeVideoId(url)) {
      const meta = await fetchYoutubeMetadata(url, controller.signal);
      return meta ? { url, ...meta, socialPost: null, videoEmbed: null } : null;
    }

    let base: LinkMetadataDto | null = null;
    const pickaxPost = isPickaxPostUrl(u.toString());
    let pickaxPartial: LinkMetadataDto | null = null;

    if (isXPostUrl(u.toString())) {
      const xMetadata = await enrichXPost(
        u.toString(),
        controller.signal,
      );
      if (xMetadata) return xMetadata;
    }

    if (isRumbleVideoUrl(u.toString())) {
      const videoEmbed = await enrichRumbleVideo(
        u.toString(),
        controller.signal,
      );
      if (videoEmbed) {
        return {
          url: u.toString(),
          title: null,
          description: null,
          imageUrl: videoEmbed.thumbnailUrl,
          siteName: "Rumble",
          socialPost: null,
          videoEmbed,
        };
      }
    }

    if (isSubstackPostUrl(u.toString())) {
      const enriched = await enrichSubstackPost(
        u.toString(),
        controller.signal,
      );
      if (enriched) {
        return {
          url: u.toString(),
          title: null,
          description: null,
          imageUrl: null,
          siteName: null,
          ...enriched,
          socialPost: null,
          videoEmbed: null,
        };
      }
    }

    // Jina is the only public source that provides the complete Pickax body and,
    // when available, author avatar/handle. Give it the full timeout budget
    // instead of spending most of that budget on weak OG metadata first.
    if (pickaxPost) {
      pickaxPartial = await enrichPickaxPost(
        u.toString(),
        null,
        controller.signal,
      );
      if (pickaxPartial?.description) return pickaxPartial;
    }

    try {
      const microlinkUrl = `https://api.microlink.io/?url=${encodeURIComponent(u.toString())}&screenshot=false`;
      const r = await fetch(microlinkUrl, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      });
      if (r.ok) {
        const json = JSON.parse(
          (await readLimitedResponse(r, 1_048_576)).toString("utf8"),
        ) as MicrolinkResponse;
        if (json?.status === "success" && json.data) {
          const img = Array.isArray(json.data.image)
            ? json.data.image?.[0]?.url
            : (json.data.image as { url?: string } | undefined)?.url;
          base = {
            url: normalizeText(json.data.url ?? null) ?? u.toString(),
            title: normalizeText(json.data.title ?? null),
            description: normalizeText(json.data.description ?? null),
            siteName:
              normalizeText(json.data.publisher ?? null) ??
              normalizeText(json.data.author ?? null),
            imageUrl: normalizeText(img ?? null),
            socialPost: null,
            videoEmbed: null,
          };
        }
      }
    } catch {
      // fall through to Jina
    }

    // Pickax OG tags only expose favicon + "Name posted". Scrape the readable page for
    // the author avatar and @handle so clients can render a post-like card.
    if (pickaxPost) {
      if (pickaxPartial) {
        return {
          ...base,
          ...pickaxPartial,
          description: pickaxPartial.description ?? base?.description ?? null,
        };
      }
      if (base) {
        return {
          ...base,
          title: pickaxAuthorFromTitle(base.title) ?? base.title,
          siteName: "Pickax",
          imageUrl: isWeakPickaxImage(base.imageUrl) ? null : base.imageUrl,
        };
      }
    } else if (base) {
      return base;
    }

    const proxied = `https://r.jina.ai/${u.toString()}`;
    const res = await fetch(proxied, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const md = (await readLimitedResponse(res, 1_048_576)).toString("utf8");

    const titleMatch = (md ?? "").toString().match(/^\s*Title:\s*(.+)\s*$/m);
    const title = normalizeText(titleMatch?.[1] ?? null);
    const imageMatch = (md ?? "")
      .toString()
      .match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i);
    const imageUrl = normalizeText(imageMatch?.[1] ?? null);

    return {
      url: u.toString(),
      title,
      description: null,
      siteName: normalizeText(u.hostname.replace(/^www\./, "")) ?? null,
      imageUrl,
      socialPost: null,
      videoEmbed: null,
    };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "AbortError" || name === "TimeoutError") return null;
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function enrichXPost(
  url: string,
  signal: AbortSignal,
): Promise<LinkMetadataDto | null> {
  try {
    const parsed = parseXPostUrl(url);
    if (!parsed) return null;
    const token = xSyndicationToken(parsed.id);
    const response = await fetch(
      `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(parsed.id)}&lang=en&token=${encodeURIComponent(token)}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        signal,
      },
    );
    if (!response.ok) return null;
    const socialPost = parseXSyndicationResponse(await response.json(), url);
    if (!socialPost) return null;
    return {
      url: parsed.canonicalUrl,
      title: socialPost.author.name,
      description: socialPost.text,
      imageUrl: socialPost.author.avatarUrl,
      siteName: "X",
      socialPost,
      videoEmbed: null,
    };
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "AbortError" || name === "TimeoutError") return null;
    logger.warn(
      `[link-metadata] X enrichment failed for ${url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
