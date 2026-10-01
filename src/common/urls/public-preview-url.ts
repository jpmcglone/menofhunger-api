import { isIP } from "node:net";

/** Public preview inputs, never credentials or creator API URLs. */
export function publicPreviewUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      isIP(host) ||
      !host.includes(".") ||
      /\.(localhost|local|internal|test|invalid)$/.test(host)
    )
      return null;
    if (
      (host === "rumble.com" || host.endsWith(".rumble.com")) &&
      (/api|livestream/i.test(url.pathname) ||
        [...url.searchParams.keys()].some((key) =>
          /key|token|secret/i.test(key),
        ))
    )
      return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
