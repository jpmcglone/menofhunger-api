import { ForbiddenException } from "@nestjs/common";
import type { MessageMediaInput } from "./messages.models";

/** Check media access even when replying to a conversation that bypasses the chat entry gate. */
export function assertMessageMediaPermissions(
  sender: {
    verifiedStatus: string;
    premium: boolean;
    premiumPlus: boolean;
  } | null,
  media: MessageMediaInput[],
) {
  if (media.length > 0) {
    const viewerIsVerified = Boolean(
      sender?.verifiedStatus && sender.verifiedStatus !== "none",
    );
    const viewerIsPremium = Boolean(sender?.premium || sender?.premiumPlus);
    const hasVideo = media.some((m) => m.kind === "video");
    const hasAudio = media.some((m) => m.kind === "audio");
    const hasImageOrGif = media.some(
      (m) => m.kind !== "video" && m.kind !== "audio",
    );
    if ((hasImageOrGif || hasAudio) && !viewerIsVerified) {
      throw new ForbiddenException(
        "Verify your account to send photos and voice notes in chat.",
      );
    }
    if (hasVideo && !viewerIsPremium) {
      throw new ForbiddenException(
        "Video messages are for premium members only.",
      );
    }
  }
}
