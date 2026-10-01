import { publicPreviewUrl } from "../../common/urls/public-preview-url";
import type { LinkMetadataDto } from "./link-metadata.service";

/** A login/registration/challenge page is not a person's public profile. */
export function profileLinkMetadata(
  meta: LinkMetadataDto | null,
): LinkMetadataDto | null {
  if (!meta || !publicPreviewUrl(meta.url)) return null;
  if (
    /\b(log[ -]?in|sign[ -]?in|sign[ -]?up|registration|security check|just a moment)\b/i.test(
      meta.title ?? "",
    )
  )
    return null;
  return {
    ...meta,
    title: meta.title?.slice(0, 500) ?? null,
    description: meta.description?.slice(0, 1500) ?? null,
    imageUrl: meta.imageUrl ? publicPreviewUrl(meta.imageUrl) : null,
    socialPost: null,
    videoEmbed: null,
  };
}
