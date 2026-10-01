import { readLimitedResponse } from "../../common/http/read-limited-response";

export type PublicProfileMetadata = {
  platform: "pickax";
  username: string;
  avatarUrl: string | null;
  followers: number | null;
  following: number | null;
};

export function pickaxProfileHandle(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (
      u.protocol !== "https:" ||
      !["pickax.com", "www.pickax.com"].includes(u.hostname) ||
      u.username ||
      u.password ||
      u.port ||
      u.search
    )
      return null;
    return (
      /^\/([a-zA-Z0-9_.-]{1,50})\/?$/.exec(u.pathname)?.[1]?.toLowerCase() ??
      null
    );
  } catch {
    return null;
  }
}

/** Read only the requested profile's public SSR record; never execute page scripts. */
export function parsePickaxProfile(html: string, handle: string) {
  try {
    const json =
      /<script\b[^>]*\bid=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(
        html,
      )?.[1];
    if (!json) return null;
    const values: unknown = JSON.parse(json);
    if (!Array.isArray(values) || values.length > 50000) return null;
    const at = (ref: unknown): unknown =>
      typeof ref === "number" && Number.isInteger(ref) && ref >= 0
        ? values[ref]
        : undefined;
    const record = (v: unknown): Record<string, unknown> =>
      v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : {};
    const root = record(at((values[0] as unknown[])?.[1]));
    const data = at(root.data);
    const profiles = record(at(Array.isArray(data) ? data[1] : undefined));
    const profile = record(at(profiles[`profile_${handle}`]));
    const author = record(at(profile.authorData));
    const username = at(author.username);
    if (
      typeof username !== "string" ||
      username.toLowerCase() !== handle ||
      at(author.banned) === true
    )
      return null;
    const text = (ref: unknown, max: number) => {
      const v = at(ref);
      return typeof v === "string" ? v.trim().slice(0, max) || null : null;
    };
    const asset = (ref: unknown) => {
      const v = text(ref, 500);
      return v && /^user-\d+\/[a-zA-Z0-9_.-]+$/.test(v)
        ? `https://img.pickax.com/${v}`
        : null;
    };
    const counts = record(at(author._count));
    const count = (ref: unknown) => {
      const v = at(ref);
      return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
        ? v
        : null;
    };
    const title = text(author.fullname, 200);
    if (!title) return null;
    return {
      url: `https://pickax.com/${handle}`,
      title,
      description: text(author.bio, 1500),
      imageUrl: asset(author.background),
      siteName: "Pickax",
      socialPost: null,
      videoEmbed: null,
      profile: {
        platform: "pickax" as const,
        username,
        avatarUrl: asset(author.avatar),
        followers: count(counts.followers),
        following: count(counts.following),
      },
    };
  } catch {
    return null;
  }
}

export async function fetchPickaxProfile(handle: string) {
  const response = await fetch(
    `https://pickax.com/${encodeURIComponent(handle)}`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "MenOfHunger/1.0 (+https://menofhunger.com)" },
    },
  );
  if (!response.ok) return null;
  return parsePickaxProfile(
    (await readLimitedResponse(response, 1_048_576)).toString("utf8"),
    handle,
  );
}
