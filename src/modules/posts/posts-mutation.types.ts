import type { PostVisibility } from "@prisma/client";

export type CreatePostParams = {
  /** Internal scheduler claim, consumed in the publication transaction. */
  scheduledSource?: { id: string; revision: number };
  crosspost?: { pickax?: "link" | "native"; x?: "link" | "native" };
  userId: string;
  body: string;
  visibility: PostVisibility;
  parentId?: string | null;
  mentions?: string[] | null;
  media: Array<{
    source: "upload" | "giphy";
    kind: "image" | "gif" | "video";
    r2Key?: string;
    thumbnailR2Key?: string;
    url?: string;
    mp4Url?: string;
    width?: number;
    height?: number;
    durationSeconds?: number;
    alt?: string | null;
  }> | null;
  poll: {
    endsAt: Date;
    options: Array<{
      text: string;
      image: {
        r2Key: string;
        width: number | null;
        height: number | null;
        alt: string | null;
      } | null;
    }>;
  } | null;
  kind?: "regular" | "checkin" | "status" | "board";
  /** kind=board thread roots only (validated by BoardService). */
  board?: {
    title: string;
    url: string | null;
    urlNormalized: string | null;
    domain: string | null;
    tags: string[];
    showInFeed: boolean;
  } | null;
  /** kind=board thread roots created from an article publish. */
  articleId?: string | null;
  checkinDayKey?: string | null;
  checkinPrompt?: string | null;
  /** Top-level post only: creates a post inside this community group (membership required). */
  communityGroupId?: string | null;
  /**
   * Optional Marv reply-mode hint, sourced from the `x-marv-mode` request header. Only
   * has any effect when @marv is mentioned in the body — the public-reply processor reads
   * this off the enqueued job to choose the OpenAI model. Ignored otherwise.
   */
  marvMode?: "fast" | "regular" | "smart" | null;
};
