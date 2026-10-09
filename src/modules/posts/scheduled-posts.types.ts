export type ScheduledPostNewMediaInput = {
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
};

export type ScheduledPostMediaInput =
  | { source: "existing"; id: string; alt?: string | null }
  | ScheduledPostNewMediaInput;

export type ScheduledPollInput = {
  options: Array<{ text: string }>;
  durationHours: number;
};
