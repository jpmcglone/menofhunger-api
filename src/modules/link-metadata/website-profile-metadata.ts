import { resolve4 } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { publicPreviewUrl } from "../../common/urls/public-preview-url";

/** IPv4-only outbound lookup; IPv6-only sites retain the existing scraper fallback. */
export function publicAddress(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  )
    return false;
  const [a, b] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}

function decode(value: string): string {
  return value
    .replace(
      /&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,
      (all, entity: string) => {
        const named: Record<string, string> = {
          amp: "&",
          quot: '"',
          apos: "'",
          lt: "<",
          gt: ">",
          nbsp: " ",
        };
        if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? all;
        const code =
          entity[1].toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      },
    )
    .trim();
}

export function parseWebsiteMetadata(html: string, url: string) {
  const tags = new Map<string, string>();
  // Only document metadata, never text in scripts, comments, or page content.
  const head = html
    .split(/<\/head\s*>/i)[0]
    .replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const match of tag.matchAll(
      /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
    ))
      attrs.set(
        match[1].toLowerCase(),
        decode(match[2] ?? match[3] ?? match[4]),
      );
    const key = attrs.get("property") ?? attrs.get("name");
    if (key && attrs.get("content") && !tags.has(key.toLowerCase()))
      tags.set(key.toLowerCase(), attrs.get("content")!);
  }
  const title =
    tags.get("og:title") ??
    tags.get("twitter:title") ??
    decode(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "");
  const description =
    tags.get("og:description") ??
    tags.get("twitter:description") ??
    tags.get("description");
  const image = tags.get("og:image") ?? tags.get("twitter:image");
  let imageUrl: string | null = null;
  try {
    if (image) imageUrl = publicPreviewUrl(new URL(image, url).href);
  } catch {
    /* Missing or malformed optional image. */
  }
  if (!title && !description && !imageUrl) return null;
  return {
    url,
    title: title?.slice(0, 500) || null,
    description: description?.slice(0, 1500) || null,
    imageUrl,
    siteName: tags.get("og:site_name")?.slice(0, 200) ?? new URL(url).hostname,
    socialPost: null,
    videoEmbed: null,
  };
}

export async function fetchWebsiteMetadata(raw: string) {
  const signal = AbortSignal.timeout(6000);
  let current = raw;
  for (let hop = 0; hop < 4; hop++) {
    const safe = publicPreviewUrl(current);
    if (!safe) return null;
    const url = new URL(safe);
    const addresses = await resolve4(url.hostname);
    if (!addresses.length || !addresses.every(publicAddress) || signal.aborted)
      return null;
    // Pin the checked DNS address to the connection, preventing a second lookup/rebinding.
    const result = await new Promise<{ html?: string; redirect?: string }>(
      (resolve, reject) => {
        const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
          url,
          {
            signal,
            headers: {
              "User-Agent": "MenOfHunger/1.0 (+https://menofhunger.com)",
              Accept: "text/html",
              "Accept-Encoding": "identity",
            },
            lookup: (_host, options, callback) => {
              if (options.all)
                callback(null, [{ address: addresses[0], family: 4 }]);
              else callback(null, addresses[0], 4);
            },
          },
          (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
              res.resume();
              resolve({ redirect: res.headers.location });
              return;
            }
            if (
              res.statusCode !== 200 ||
              !/text\/html|application\/xhtml\+xml/i.test(
                res.headers["content-type"] ?? "",
              )
            ) {
              res.resume();
              resolve({});
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 1_048_576) {
                res.destroy();
                reject(new Error("Metadata response too large"));
                return;
              }
              chunks.push(chunk);
            });
            res.on("error", reject);
            res.on("end", () =>
              resolve({ html: Buffer.concat(chunks).toString("utf8") }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    if (result.html) {
      const metadata = parseWebsiteMetadata(result.html, current);
      return metadata ? { ...metadata, url: raw } : null;
    }
    if (!result.redirect) return null;
    current = new URL(result.redirect, current).href;
  }
  return null;
}
