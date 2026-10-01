import { z } from "zod";
import type { XProfilePreviewDto } from "../../common/dto/integrations.dto";

export function publicXUrl(raw: unknown, image = false): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (
      url.username ||
      url.password ||
      !["http:", "https:"].includes(url.protocol)
    )
      return null;
    if (
      image &&
      (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com")
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

const profileSchema = z.object({
  id: z.string().regex(/^\d+$/),
  username: z.string().min(1).max(15),
  name: z.string().max(200),
  withheld: z.unknown().optional(),
  protected: z.boolean(),
  description: z.string().max(5000).optional(),
  profile_image_url: z.string().optional(),
  profile_banner_url: z.string().optional(),
  url: z.string().optional(),
  verified: z.boolean().optional(),
  public_metrics: z
    .object({
      followers_count: z.number().int().nonnegative(),
      following_count: z.number().int().nonnegative(),
    })
    .optional(),
});

export function mapXProfile(
  data: unknown,
  expectedId: string,
  now = new Date(),
): XProfilePreviewDto | null {
  const result = profileSchema.safeParse(data);
  if (
    !result.success ||
    result.data.protected ||
    result.data.withheld ||
    result.data.id !== expectedId
  )
    return null;
  const p = result.data;
  return {
    id: p.id,
    username: p.username,
    name: p.name,
    description: p.description ?? null,
    avatarUrl: publicXUrl(p.profile_image_url, true),
    bannerUrl: publicXUrl(p.profile_banner_url, true),
    websiteUrl: publicXUrl(p.url),
    verified: p.verified === true,
    followers: p.public_metrics?.followers_count ?? null,
    following: p.public_metrics?.following_count ?? null,
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  };
}
