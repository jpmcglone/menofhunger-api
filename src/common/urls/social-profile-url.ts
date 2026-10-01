import { BadRequestException } from "@nestjs/common";

export type PublicProfileProvider = "rumble" | "linkedin" | "youtube";

/** Only canonical public profile/channel routes; never publish creator API keys. */
export function normalizeSocialProfileUrl(
  value: string,
  provider: PublicProfileProvider,
): string | null {
  const raw = value.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new BadRequestException(`Enter a valid ${provider} profile URL.`);
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new BadRequestException(
      "Use a public profile URL without credentials, query parameters, or fragments.",
    );
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "");
  const valid =
    provider === "rumble"
      ? host === "rumble.com" && /^\/(?:user|c)\/[A-Za-z0-9_-]+$/.test(path)
      : provider === "linkedin"
        ? host === "linkedin.com" &&
          /^\/(?:in|company)\/[A-Za-z0-9_-]+$/.test(path)
        : host === "youtube.com" &&
          /^\/(?:@[A-Za-z0-9_.-]+|channel\/[A-Za-z0-9_-]+|(?:c|user)\/[A-Za-z0-9_.-]+)$/.test(
            path,
          );
  if (!valid)
    throw new BadRequestException(
      `Use a public ${provider} profile or channel URL.`,
    );
  return `https://${host}${path}`;
}
