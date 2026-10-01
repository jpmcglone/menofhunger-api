import { BadRequestException } from "@nestjs/common";
import {
  xBlockerMessage,
  xPostBlocker,
  type CrosspostMode,
} from "./crosspost-eligibility";

/** Validate fresh requests before storing a post or a scheduled cross-post choice. */
export function assertXCrosspostInput(
  input: {
    crosspost?: { x?: CrosspostMode };
    body: string;
    visibility: string;
    media?: Array<{
      kind: string;
      source: string;
      r2Key?: string | null;
      deletedAt?: Date | null;
    }> | null;
    poll?: unknown;
    communityGroupId?: string | null;
    parentId?: string | null;
    kind?: string;
    board?: unknown;
  },
  linksEnabled = false,
) {
  if (!input.crosspost?.x) return;
  const reason = xPostBlocker(
    {
      body: input.body,
      visibility: input.visibility,
      kind: input.kind ?? "regular",
      boardOnly: Boolean(input.board),
      communityGroupId: input.communityGroupId ?? null,
      parentId: input.parentId ?? null,
      quotedPostId: null,
      repostedPostId: null,
      isDraft: false,
      deletedAt: null,
      scheduledAt: null,
      hasPoll: Boolean(input.poll),
      media: (input.media ?? []).map((m) => ({
        ...m,
        r2Key: m.r2Key ?? null,
        deletedAt: m.deletedAt ?? null,
      })),
    },
    input.crosspost.x,
    linksEnabled,
  );
  if (reason) throw new BadRequestException(xBlockerMessage(reason));
}
