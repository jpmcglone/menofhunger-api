import { BadRequestException } from "@nestjs/common";
import type { CreatePostParams } from "./posts-mutation.types";

export function mutationUploadPrefixes(userId: string) {
  return {
    allowedImagePrefixes: [
      `uploads/${userId}/images/`,
      `dev/uploads/${userId}/images/`,
    ],
    allowedVideoPrefixes: [
      `uploads/${userId}/videos/`,
      `dev/uploads/${userId}/videos/`,
    ],
    allowedThumbnailPrefixes: [
      `uploads/${userId}/thumbnails/`,
      `dev/uploads/${userId}/thumbnails/`,
    ],
  };
}

export function cleanMutationMediaAndPoll(params: {
  media: NonNullable<CreatePostParams["media"]> | [];
  poll: CreatePostParams["poll"];
  reusedKeyRows: Array<{ r2Key: string }>;
  allowedImagePrefixes: string[];
  allowedVideoPrefixes: string[];
  allowedThumbnailPrefixes: string[];
}) {
  const {
    media,
    poll,
    reusedKeyRows,
    allowedImagePrefixes,
    allowedVideoPrefixes,
    allowedThumbnailPrefixes,
  } = params;
    const reusedKeySet = new Set(reusedKeyRows.map((r) => r.r2Key));

    const cleanedMedia = media
      .map((m, idx) => {
        const source = m.source;
        const kind = m.kind;
        const r2Key = (m.r2Key ?? "").trim();
        const thumbnailR2Key = (m.thumbnailR2Key ?? "").trim() || null;
        const url = (m.url ?? "").trim();
        const mp4Url = (m.mp4Url ?? "").trim();
        const width =
          typeof m.width === "number" && Number.isFinite(m.width)
            ? Math.max(1, Math.floor(m.width))
            : null;
        const height =
          typeof m.height === "number" && Number.isFinite(m.height)
            ? Math.max(1, Math.floor(m.height))
            : null;
        const durationSeconds =
          typeof m.durationSeconds === "number" &&
          Number.isFinite(m.durationSeconds) &&
          m.durationSeconds >= 0
            ? Math.floor(m.durationSeconds)
            : null;
        const alt = (m.alt ?? "").trim().slice(0, 500) || null;

        if (source === "upload") {
          if (!r2Key)
            throw new BadRequestException("Invalid uploaded media key.");
          const isReusedKey = reusedKeySet.has(r2Key);
          if (kind === "video") {
            if (
              !isReusedKey &&
              !allowedVideoPrefixes.some((p) => r2Key.startsWith(p))
            ) {
              throw new BadRequestException("Invalid uploaded video key.");
            }
            if (
              thumbnailR2Key &&
              !allowedThumbnailPrefixes.some((p) =>
                thumbnailR2Key.startsWith(p),
              )
            ) {
              throw new BadRequestException("Invalid thumbnail key.");
            }
            return {
              source,
              kind,
              r2Key,
              thumbnailR2Key: thumbnailR2Key || undefined,
              url: null,
              mp4Url: null,
              width,
              height,
              durationSeconds,
              alt,
              position: idx,
            };
          }
          if (
            !isReusedKey &&
            !allowedImagePrefixes.some((p) => r2Key.startsWith(p))
          ) {
            throw new BadRequestException("Invalid uploaded media key.");
          }
          return {
            source,
            kind,
            r2Key,
            thumbnailR2Key: undefined,
            url: null,
            mp4Url: null,
            width,
            height,
            durationSeconds: null,
            alt,
            position: idx,
          };
        }

        if (!url) throw new BadRequestException("Invalid Giphy media URL.");
        return {
          source,
          kind,
          r2Key: null,
          thumbnailR2Key: undefined,
          url,
          mp4Url: mp4Url || null,
          width,
          height,
          durationSeconds: null,
          alt,
          position: idx,
        };
      })
      .filter(Boolean);

    const cleanedPollOptions = poll
      ? (poll.options ?? []).map((o, idx) => {
          const text = (o?.text ?? "").trim().slice(0, 30);
          const img = o?.image ?? null;
          if (!text && !img)
            throw new BadRequestException(
              "Poll option must include text or an image.",
            );
          if (!img) {
            return {
              text,
              position: idx,
              imageR2Key: null as string | null,
              imageWidth: null as number | null,
              imageHeight: null as number | null,
              imageAlt: null as string | null,
            };
          }
          const r2Key = (img.r2Key ?? "").trim();
          if (!r2Key)
            throw new BadRequestException("Invalid poll option image key.");
          const isReusedKey = reusedKeySet.has(r2Key);
          if (
            !isReusedKey &&
            !allowedImagePrefixes.some((p) => r2Key.startsWith(p))
          ) {
            throw new BadRequestException("Invalid poll option image key.");
          }
          const width =
            typeof img.width === "number" && Number.isFinite(img.width)
              ? Math.max(1, Math.floor(img.width))
              : null;
          const height =
            typeof img.height === "number" && Number.isFinite(img.height)
              ? Math.max(1, Math.floor(img.height))
              : null;
          const alt = (img.alt ?? "").trim().slice(0, 500) || null;
          return {
            text,
            position: idx,
            imageR2Key: r2Key,
            imageWidth: width,
            imageHeight: height,
            imageAlt: alt,
          };
        })
      : null;

  return { cleanedMedia, cleanedPollOptions };
}
