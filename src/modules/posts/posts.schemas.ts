import { z } from "zod";
import { listSchema } from "./posts-list-query.service";
import {
  limitQuery,
  cursorPageQuerySchema,
} from "../../common/pagination/cursor-query.schema";
import { queryBoolean } from "../../common/validation/query-boolean";

/** Request schemas for PostsController (parsing only; behavior lives in the controller/services). */
export const userListSchema = listSchema.extend({
  visibility: z
    .enum(["all", "public", "verifiedOnly", "premiumOnly"])
    .optional(),
  includeCounts: queryBoolean().optional(),
  topLevelOnly: queryBoolean().optional(),
  includeRestricted: queryBoolean().optional(),
});

export const userMediaListSchema = cursorPageQuerySchema().extend({
  visibility: z
    .enum(["all", "public", "verifiedOnly", "premiumOnly"])
    .optional(),
  sort: z.enum(["new", "trending"]).optional(),
  includeRestricted: queryBoolean().optional(),
});

export const createUploadMediaItemSchema = z.object({
  source: z.literal("upload"),
  kind: z.enum(["image", "gif", "video"]),
  r2Key: z.string().min(1),
  thumbnailR2Key: z.string().min(1).optional(),
  width: z.coerce.number().int().min(1).max(20000).optional(),
  height: z.coerce.number().int().min(1).max(20000).optional(),
  durationSeconds: z.coerce.number().int().min(0).max(3600).optional(),
  alt: z.string().trim().max(500).nullish(),
});

export const createPollOptionImageSchema = z.object({
  source: z.literal("upload"),
  kind: z.literal("image"),
  r2Key: z.string().min(1),
  width: z.coerce.number().int().min(1).max(20000).optional(),
  height: z.coerce.number().int().min(1).max(20000).optional(),
  alt: z.string().trim().max(500).nullish(),
});

export const createMediaItemSchema = z.discriminatedUnion("source", [
  createUploadMediaItemSchema,
  z.object({
    source: z.literal("giphy"),
    kind: z.literal("gif"),
    url: z.string().url(),
    mp4Url: z.string().url().optional(),
    width: z.coerce.number().int().min(1).max(20000).optional(),
    height: z.coerce.number().int().min(1).max(20000).optional(),
    alt: z.string().trim().max(500).nullish(),
  }),
]);

export type CreateMediaItem = z.infer<typeof createMediaItemSchema>;

export const createPollSchema = z
  .object({
    options: z
      .array(
        z.object({
          text: z.string().trim().max(30).optional(),
          image: createPollOptionImageSchema.nullish(),
        }),
      )
      .min(2)
      .max(5),
    duration: z.object({
      days: z.coerce.number().int().min(0).max(7),
      hours: z.coerce.number().int().min(0).max(23),
      minutes: z.coerce.number().int().min(0).max(59),
    }),
  })
  .superRefine((val, ctx) => {
    const opts = val.options ?? [];
    for (let i = 0; i < opts.length; i++) {
      const o = opts[i]!;
      const text = (o.text ?? "").trim();
      const hasText = Boolean(text);
      const hasImage = Boolean(o.image?.r2Key);
      if (!hasText && !hasImage) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Poll option must include text or an image.",
          path: ["options", i, "text"],
        });
      }
    }

    // Product rule: if any option includes an image, all options must include an image.
    const anyHasImage = opts.some((o) => Boolean(o?.image?.r2Key));
    if (anyHasImage) {
      for (let i = 0; i < opts.length; i++) {
        const o = opts[i]!;
        if (!o?.image?.r2Key) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "If any poll option has an image, all poll options must have images.",
            path: ["options", i, "image"],
          });
        }
      }
    }
  });

export const createSchema = z
  .object({
    body: z.string().trim().max(1000).optional(),
    visibility: z
      .enum(["public", "verifiedOnly", "premiumOnly", "onlyMe"])
      .optional(),
    parent_id: z.string().cuid().optional(),
    /** Top-level posts only: post into this community group (must be an active member). */
    community_group_id: z.string().cuid().optional(),
    mentions: z.array(z.string().min(1).max(120)).max(20).optional(),
    media: z.array(createMediaItemSchema).max(4).optional(),
    poll: createPollSchema.optional(),
    /** Also publish to the author's connected Pickax account when the post qualifies. */
    crossPostToPickax: z.boolean().optional(),
    /** Per-destination choice. `crossPostToPickax: true` still means a full Pickax post. */
    crosspost: z
      .object({
        pickax: z.enum(["link", "native"]).optional(),
        x: z.literal("native").optional(),
      })
      .optional(),
  })
  .superRefine((val, ctx) => {
    const body = (val.body ?? "").trim();
    const mediaCount = val.media?.length ?? 0;
    const hasPoll = Boolean(val.poll);
    if (!body && mediaCount === 0 && !hasPoll) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Post must include text, media, or a poll.",
        path: ["body"],
      });
    }
    if (hasPoll && mediaCount > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "You cannot attach media to a poll post.",
        path: ["media"],
      });
    }
    if (hasPoll && val.parent_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Polls are not allowed on replies.",
        path: ["poll"],
      });
    }
    if (hasPoll) {
      const d = val.poll?.duration;
      const days = typeof d?.days === "number" ? d.days : 0;
      const hours = typeof d?.hours === "number" ? d.hours : 0;
      const minutes = typeof d?.minutes === "number" ? d.minutes : 0;
      const totalSeconds = days * 24 * 60 * 60 + hours * 60 * 60 + minutes * 60;
      if (totalSeconds <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Poll duration must be at least 1 minute.",
          path: ["poll", "duration"],
        });
      }
      if (totalSeconds > 7 * 24 * 60 * 60) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Poll duration must be 7 days or shorter.",
          path: ["poll", "duration"],
        });
      }
      if (days === 7 && (hours > 0 || minutes > 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "When days is 7, hours and minutes must be 0.",
          path: ["poll", "duration"],
        });
      }
    }
    // Video uploads: require dimensions and duration; MB + duration limits enforced server-side.
    for (let i = 0; i < (val.media ?? []).length; i++) {
      const item = val.media![i];
      if (item.source !== "upload" || item.kind !== "video") continue;
      const width = typeof item.width === "number" ? item.width : null;
      const height = typeof item.height === "number" ? item.height : null;
      const durationSeconds =
        typeof item.durationSeconds === "number" ? item.durationSeconds : null;
      if (width == null || height == null || durationSeconds == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Video media must include width, height, and durationSeconds.",
          path: ["media", i, "width"],
        });
        continue;
      }
      if (durationSeconds > 5 * 60) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Video must be 5 minutes or shorter.",
          path: ["media", i, "durationSeconds"],
        });
      }
    }
  });

export const updateSchema = z
  .object({
    body: z.string().trim().max(1000).optional(),
  })
  .superRefine((val, ctx) => {
    const body = (val.body ?? "").trim();
    if (!body) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Post must include text.",
        path: ["body"],
      });
    }
  });

export const publishFromOnlyMeSchema = z.object({
  body: z.string().trim().max(1000).optional(),
  visibility: z.enum(["public", "verifiedOnly", "premiumOnly"]),
  media: z
    .array(
      z.discriminatedUnion("source", [
        z.object({
          source: z.literal("existing"),
          id: z.string().min(1),
          alt: z.string().trim().max(500).nullish(),
        }),
        createUploadMediaItemSchema,
        z.object({
          source: z.literal("giphy"),
          kind: z.literal("gif"),
          url: z.string().url(),
          mp4Url: z.string().url().optional(),
          width: z.coerce.number().int().min(1).max(20000).optional(),
          height: z.coerce.number().int().min(1).max(20000).optional(),
          alt: z.string().trim().max(500).nullish(),
        }),
      ]),
    )
    .max(4)
    .optional(),
});

/**
 * Parse the optional `x-marv-mode` request header into the `MarvinMode` enum.
 * Returns null when the header is missing/invalid — the public-reply processor will
 * fall back to the user's stored preferred mode in that case.
 */
export function parseMarvModeHeader(
  raw: string | undefined,
): "fast" | "regular" | "smart" | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "fast" || v === "regular" || v === "smart") return v;
  return null;
}

/** Shared read contracts across the focused post controllers. */
export const postCommentsQuerySchema = cursorPageQuerySchema().extend({
  visibility: z
    .enum(["all", "public", "verifiedOnly", "premiumOnly"])
    .optional(),
  sort: z.enum(["new", "popular", "trending"]).optional(),
});
export const postRelationsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: limitQuery(50),
});
export const postDiscoveryQuerySchema = postRelationsQuerySchema.extend({
  /** Opaque client seed for soft shuffle; reuse across pages, rotate on remount. */
  seed: z.string().trim().min(1).max(64).optional(),
});
export const postPollVoteSchema = z.object({ optionId: z.string().cuid() });
