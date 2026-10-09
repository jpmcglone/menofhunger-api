import type { CrosspostMode } from "@prisma/client";

export type XQueueResult =
  | { status: "queued"; mode: CrosspostMode }
  | { status: "skipped"; reason: string };

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type LoadedPost = {
  userId: string;
  body: string;
  visibility: string;
  kind: string;
  boardOnly: boolean;
  isDraft: boolean;
  deletedAt: Date | null;
  scheduledAt: Date | null;
  parentId: string | null;
  communityGroupId: string | null;
  quotedPostId: string | null;
  repostedPostId: string | null;
  hasPoll: boolean;
  boardTitle?: string | null;
  media: Array<{
    kind: string;
    source: string;
    r2Key: string | null;
    alt: string | null;
    deletedAt: Date | null;
    position: number;
  }>;
};

function linkBase(frontendBaseUrl: string | null | undefined): string {
  return (frontendBaseUrl ?? "https://menofhunger.com").replace(/\/+$/, "");
}

export function xArticleLinkText(frontendBaseUrl: string | null | undefined, id: string, title: string): string {
  return `${title}\n${linkBase(frontendBaseUrl)}/a/${encodeURIComponent(id)}`;
}

export function xBoardLinkText(frontendBaseUrl: string | null | undefined, id: string, title?: string | null): string {
  return `${(title ?? "").trim()}\n${linkBase(frontendBaseUrl)}/b/${encodeURIComponent(id)}`.trim();
}
