import { createHash } from "crypto";
import { z } from "zod";
import {
  xContainsLink,
  xWeightedLength,
  xPostCostMicros,
} from "../../common/crosspost/crosspost-eligibility";

const id = z.string().regex(/^\d{1,19}$/);
export const xPublishingInput = z
  .object({
    parts: z.array(z.string().max(25000)).min(1).max(20),
    replyToId: id.nullable().default(null),
    quoteId: id.nullable().default(null),
    edit: z.boolean().default(false),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type XPublishingInput = z.infer<typeof xPublishingInput>;
export type XPublishingPolicy = {
  enabled: boolean;
  accountIds: string[];
  quoteAccountIds: string[];
  longAccountIds: string[];
  editAccountIds: string[];
  postMaxMicros?: number;
  mediaMaxMicros?: number;
  priceVersion: string;
};
export type XPublishingSource = {
  body: string;
  media: Array<{
    id: string;
    kind: string;
    source: string;
    r2Key: string | null;
    alt: string | null;
    deletedAt: Date | null;
  }>;
  poll: {
    endsAt: Date;
    options: Array<{ text: string; imageR2Key: string | null }>;
  } | null;
};
export function xSourceHash(source: XPublishingSource): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        source.body,
        source.media.map((m) => [
          m.id,
          m.kind,
          m.source,
          m.r2Key,
          m.alt,
          m.deletedAt,
        ]),
        source.poll,
      ]),
    )
    .digest("hex");
}
export function prepareXPlan(
  source: XPublishingSource,
  input: XPublishingInput,
  policy: XPublishingPolicy,
  accountId: string,
  previousId?: string | null,
) {
  if (
    !policy.enabled ||
    !policy.accountIds.includes(accountId) ||
    policy.postMaxMicros === undefined ||
    !policy.priceVersion
  )
    throw new Error(
      "Advanced X publishing needs confirmed account access and pricing.",
    );
  if (xSourceHash(source) !== input.sourceHash)
    throw new Error("The source changed. Reload the X preview.");
  if (input.replyToId && input.quoteId)
    throw new Error("Choose either a reply or a quote.");
  if (input.quoteId && !policy.quoteAccountIds.includes(accountId))
    throw new Error("X quote-posting requires approved Enterprise access.");
  if (
    input.edit &&
    (!previousId ||
      !policy.editAccountIds.includes(accountId) ||
      input.parts.length !== 1 ||
      input.replyToId ||
      input.quoteId ||
      source.poll)
  )
    throw new Error("This X copy cannot be edited in place.");
  const media = source.media;
  if (
    media.some(
      (m) =>
        m.deletedAt ||
        m.source !== "upload" ||
        !m.r2Key ||
        !["image", "video", "gif"].includes(m.kind),
    )
  )
    throw new Error("Every X attachment must be an available MOH upload.");
  if (
    media.length > 4 ||
    (media.some((m) => m.kind !== "image") && media.length !== 1)
  )
    throw new Error("X accepts four photos, one video, or one GIF.");
  if (media.some((m) => Array.from(m.alt ?? "").length > 1000))
    throw new Error("X alt text must fit within 1,000 characters.");
  if (media.some((m) => m.kind !== "image" && m.alt?.trim()))
    throw new Error(
      "Publish animated media with alt text directly on X until this format is supported.",
    );
  if (media.length && policy.mediaMaxMicros === undefined)
    throw new Error("Media upload and processing prices need confirmation.");
  if (
    source.poll &&
    (media.length || input.parts.length > 1 || input.quoteId || input.edit)
  )
    throw new Error(
      "Publish this poll on its own without media, a quote, or a thread.",
    );
  const poll = source.poll
    ? {
        options: source.poll.options.map((o) => o.text),
        duration_minutes: Math.floor(
          (source.poll.endsAt.getTime() - Date.now()) / 60000,
        ),
      }
    : undefined;
  if (
    poll &&
    (poll.options.length < 2 ||
      poll.options.length > 4 ||
      poll.options.some((t) => !t.trim() || Array.from(t).length > 25) ||
      source.poll!.options.some((o) => o.imageR2Key) ||
      poll.duration_minutes < 5 ||
      poll.duration_minutes > 10080)
  )
    throw new Error(
      "X polls need 2–4 text choices of up to 25 characters and 5 minutes–7 days remaining.",
    );
  for (const [index, text] of input.parts.entries()) {
    if (!text.trim() && !(index === 0 && media.length))
      throw new Error("Every thread part needs text.");
    const long = xWeightedLength(text) > 280;
    if (
      long &&
      (input.parts.length > 1 || !policy.longAccountIds.includes(accountId))
    )
      throw new Error(
        "Review an explicit thread or use an account approved for long posts.",
      );
    if (/[\u0000\ufffe\uffff]/.test(text))
      throw new Error("Remove unsupported characters from the X text.");
  }
  const minimum = input.parts.reduce(
    (sum, text) => sum + xPostCostMicros(text),
    0,
  );
  const maximum =
    input.parts.reduce(
      (sum, text) =>
        sum + Math.max(policy.postMaxMicros!, xPostCostMicros(text)),
      0,
    ) +
    media.length * (policy.mediaMaxMicros ?? 0);
  if (!Number.isSafeInteger(maximum) || maximum < minimum)
    throw new Error("Invalid X price estimate.");
  return {
    maximumMicros: maximum,
    publications: input.edit ? 0 : input.parts.length,
    bucket:
      input.parts.some(xContainsLink) || input.quoteId
        ? ("expensive" as const)
        : ("regular" as const),
    poll,
  };
}
