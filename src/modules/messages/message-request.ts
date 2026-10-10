import { createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import {
  messageMediaCreateData,
  type MessageMediaInput,
} from "./messages.models";

/** Hash canonical values, not the client's JSON property ordering. */
export function messageRequestHash(
  body: string,
  replyToId: string | null,
  media: MessageMediaInput[],
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        body: body.trim(),
        replyToId,
        media: messageMediaCreateData(media),
      }),
    )
    .digest("hex");
}

export function assertMessageRequestHash(
  existing: { requestHash: string | null },
  expected: string,
) {
  if (existing.requestHash !== expected)
    throw new ConflictException(
      "This request ID was already used for a different message.",
    );
}

export function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}
