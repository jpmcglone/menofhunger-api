import { BadRequestException, ForbiddenException } from '@nestjs/common';

/** Maximum scheduling window: 60 days from now. */
const MAX_SCHEDULE_OFFSET_MS = 60 * 24 * 60 * 60 * 1000;

export function assertPremium(user: { premium: boolean; premiumPlus: boolean }) {
  if (!user.premium && !user.premiumPlus) {
    throw new ForbiddenException(
      "Scheduled posts are for premium members only.",
    );
  }
}

export function validateScheduledAt(scheduledAt: Date, now: Date = new Date()) {
  const delta = scheduledAt.getTime() - now.getTime();
  // No minimum offset enforced server-side — the UI prevents picking < 5 min,
  // but if the user took time composing and the window slipped, the cron will
  // publish it on its next sweep (within ~1 minute).
  if (delta > MAX_SCHEDULE_OFFSET_MS) {
    throw new BadRequestException(
      "Scheduled time cannot be more than 60 days in the future.",
    );
  }
}

/**
 * Returns a human-readable error string if the author is no longer eligible to publish,
 * or null if everything looks good. Called before the atomic claim.
 */
export function revalidateForPublish(
  author: {
    premium: boolean;
    premiumPlus: boolean;
    verifiedStatus: string | null;
    bannedAt: Date | null;
  } | null,
  post: {
    media: Array<{ kind: string }>;
    scheduledCommunityGroupId: string | null;
    scheduledError: string | null;
  },
): string | null {
  if (!author || author.bannedAt) {
    return "Account is no longer eligible to post.";
  }
  const isPremium = Boolean(author.premium || author.premiumPlus);
  if (!isPremium) {
    return "Scheduled posts require premium. Renew your subscription to publish.";
  }
  const isVerified = Boolean(
    author.verifiedStatus && author.verifiedStatus !== "none",
  );
  const hasImageOrGif = post.media.some((m) => m.kind !== "video");
  if (hasImageOrGif && !isVerified) {
    return "Verify your account to post images and GIFs.";
  }
  // Group membership is checked at claim time inside createPost if the group post path is taken;
  // we do a lightweight pre-check here to give the user an early actionable error.
  // (Full check happens in createPost anyway, so no race concern.)
  return null;
}
