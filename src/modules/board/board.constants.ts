import { Prisma } from "@prisma/client";
import { POST_BASE_INCLUDE, POST_LIST_INCLUDE } from "../../common/prisma-includes/post.include";
import { type BoardVisibility } from "../../common/dto";
import { type BoardRange } from "./board.utils";

export type ThreadRow = Prisma.PostGetPayload<{ include: typeof POST_LIST_INCLUDE }>;
export type CommentRow = Prisma.PostGetPayload<{ include: typeof POST_BASE_INCLUDE }>;

export const EDIT_WINDOW_MS = 30 * 60 * 1000;
export const MAX_EDITS = 3;
export const BOARD_VISIBILITIES: BoardVisibility[] = [
  "public",
  "verifiedOnly",
  "premiumOnly",
];

export type BoardListParams = {
  viewerUserId: string | null;
  sort: "top" | "new";
  range: BoardRange | null;
  visibility: "all" | BoardVisibility;
  tags: string[];
  domain: string | null;
  q: string | null;
  authorUsername: string | null;
  /** Only threads the viewer hid, so they can be brought back. */
  hiddenOnly?: boolean;
  limit: number;
  cursor: string | null;
};

export type BoardCreateThreadInput = {
  title: string;
  url: string | null;
  body: string | null;
  image: {
    r2Key: string;
    width: number | null;
    height: number | null;
    alt: string | null;
  } | null;
  tags: string[];
  visibility: BoardVisibility;
  showInFeed: boolean;
};
