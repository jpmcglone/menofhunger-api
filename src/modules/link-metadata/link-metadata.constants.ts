import { type PublicProfileMetadata } from "./pickax-profile-metadata";
import { featurePageForPath } from "../../common/feature-pages";
import { type SocialPostMetadataDto } from "./x-link-metadata";
import { type VideoEmbedDto } from "./rumble-link-metadata";

export type GroupLinkPreviewDto = {
  slug: string;
  name: string;
  description: string;
  avatarUrl: string | null;
  coverUrl: string | null;
  memberCount: number;
  joinPolicy: string;
};

export type LinkMetadataDto = {
  profile?: PublicProfileMetadata | null;
  /** Rich group card; only present for verified viewers. */
  group?: GroupLinkPreviewDto | null;
  /** Set instead of `group` when the viewer must sign in or verify to see the card. */
  locked?: "signIn" | "verify" | null;
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  socialPost: SocialPostMetadataDto | null;
  videoEmbed: VideoEmbedDto | null;
};

export const FETCH_TIMEOUT_MS = 2000;
/** Pickax post pages need a longer scrape window to recover avatar + @handle. */
export const PICKAX_ENRICH_TIMEOUT_MS = 8_000;
export const X_ENRICH_TIMEOUT_MS = 6_000;
export const SUBSTACK_ENRICH_TIMEOUT_MS = 6_000;
/** Rumble does oEmbed then embedJS for encoded width/height. */
export const RUMBLE_ENRICH_TIMEOUT_MS = 6_000;
export const X_CONNECTOR_LAUNCHED_AT = new Date("2026-07-16T00:00:00.000Z");
export const STALE_DAYS = 7;
/** Keyset pagination page size when scanning recent posts during backfill. */
export const BACKFILL_POST_PAGE_SIZE = 500;
/** Hard cap on posts scanned per backfill run to bound memory/DB pressure. */
export const BACKFILL_MAX_POSTS = 20_000;
/** Hard cap on distinct URLs fetched per backfill run. */
export const BACKFILL_MAX_URLS = 2_000;

// ─── MoH internal URL handling ───────────────────────────────────────────────
// When someone shares a menofhunger.com link, we skip external scraping entirely
// (which would hit a login-redirect and cache "Login | Men of Hunger") and instead
// synthesize clean, accurate metadata from the URL path.

export const MOH_HOSTNAME = "menofhunger.com";

export function getMohPageTitle(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  const s0 = parts[0] ?? "";
  const s1 = parts[1] ?? "";

  if (!s0 || s0 === "login" || s0 === "index") return "Men of Hunger";
  if (s0 === "home") return "Home";
  if (s0 === "u" && s1) return `@${s1}`;
  if (s0 === "p") return "Post";
  if (s0 === "a") return "Article";
  if (s0 === "spaces" || s0 === "s") return "Space";
  if (s0 === "admin") return "Admin";

  if (s0 === "settings") {
    if (!s1) return "Settings";
    const settingsLabels: Record<string, string> = {
      billing: "Billing",
      account: "Account",
      notifications: "Notifications",
      verification: "Verification",
      profile: "Profile",
      privacy: "Privacy",
    };
    const label =
      settingsLabels[s1] ?? s1.charAt(0).toUpperCase() + s1.slice(1);
    return `${label} · Settings`;
  }

  const topLabels: Record<string, string> = {
    notifications: "Notifications",
    messages: "Messages",
    discover: "Discover",
    groups: "Groups",
    search: "Search",
    coins: "Coins",
    earn: "Earn",
    checkins: "Check-ins",
    explore: "Explore",
    leaderboard: "Leaderboard",
  };
  if (topLabels[s0]) return topLabels[s0]!;

  // Fallback: capitalize each path segment, join with ·
  return parts.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" · ");
}

export function buildMohSyntheticMeta(url: string): LinkMetadataDto {
  try {
    const u = new URL(url);
    // Keep the public homepage invitation aligned with web config/site.ts.
    // This is repository-owned web artwork, not an uploaded R2 object.
    const feature = u.pathname === "/"
      ? {
          title: "Men of Hunger — Join men who show up.",
          description: "Join a trusted community for men who want real conversation, not more noise. Bring your friends, find your people, and show up together.",
          image: "/images/social/home-v1.png",
        }
      : featurePageForPath(u.pathname + u.search);
    return {
      url,
      title: feature?.title ?? getMohPageTitle(u.pathname),
      description: feature?.description ?? null,
      imageUrl: feature
        ? new URL(feature.image, "https://menofhunger.com").href
        : null,
      siteName: "Men of Hunger",
      socialPost: null,
      videoEmbed: null,
    };
  } catch {
    return {
      url,
      title: "Men of Hunger",
      description: null,
      imageUrl: null,
      siteName: "Men of Hunger",
      socialPost: null,
      videoEmbed: null,
    };
  }
}

export type MicrolinkResponse = {
  status: "success" | "error";
  data?: {
    url?: string;
    title?: string;
    description?: string;
    publisher?: string;
    author?: string;
    image?: { url?: string } | { url?: string }[];
  };
};

export function normalizeText(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s ? s : null;
}

export function normalizeUrl(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}
