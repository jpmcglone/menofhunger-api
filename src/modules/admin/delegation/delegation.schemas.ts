import { z } from "zod";
import { newsletterAudienceFiltersSchema } from "../../newsletters/newsletter-audience";

export const delegationId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const workflowSchema = z.enum([
  "news",
  "community",
  "retention",
  "personal",
  "moderation",
  "export",
]);
export const scheduleSchema = z
  .object({
    frequency: z.enum(["once", "daily", "weekly"]),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("08:00"),
    timeZone: z
      .string()
      .max(80)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Choose a valid time zone.")
      .default("America/New_York"),
    weekday: z.number().int().min(0).max(6).default(1),
    at: z.string().datetime().optional(),
  })
  .strict();
export const jobInputSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(100),
    workflow: workflowSchema,
    instruction: z.string().trim().min(1).max(6000),
    actorUsername: z
      .string()
      .regex(/^@?[A-Za-z0-9_]{1,40}$/)
      .optional(),
    permission: z.enum(["review", "publish_news"]).default("review"),
    schedule: scheduleSchema,
  })
  .strict()
  .refine(
    (v) => v.permission !== "publish_news" || v.workflow === "news",
    "Automatic publishing is available only for sourced news.",
  );
export type JobInput = z.infer<typeof jobInputSchema>;
export type DelegationSchedule = z.infer<typeof scheduleSchema>;
const body = z.string().trim().min(1).max(1000);
export const sourceSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    url: z
      .string()
      .url()
      .max(2000)
      .refine(
        (v) => new URL(v).protocol === "https:",
        "Sources must use HTTPS.",
      ),
  })
  .strict();
export const actionSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("post_publish"),
      body,
      visibility: z.enum(["public", "verifiedOnly", "premiumOnly", "onlyMe"]).default("public"),
      sources: z.array(sourceSchema).max(8).default([]),
      parentId: delegationId.optional(),
      draftId: delegationId.optional(),
    })
    .strict(),
  z.object({ operation: z.literal("post_draft"), body }).strict(),
  z
    .object({
      operation: z.literal("post_draft_update"),
      draftId: delegationId,
      body,
    })
    .strict(),
  z
    .object({ operation: z.literal("post_update"), postId: delegationId, body })
    .strict(),
  z
    .object({
      operation: z.literal("post_schedule"),
      body,
      scheduledAt: z.string().datetime(),
      visibility: z.enum(["public", "verifiedOnly", "premiumOnly"]).default("public"),
      draftId: delegationId.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("bookmark_save"),
      postId: delegationId,
      collectionIds: z.array(delegationId).max(20).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("bookmark_collection"),
      name: z.string().trim().min(1).max(60),
    })
    .strict(),
  z
    .object({
      operation: z.literal("profile_update"),
      name: z.string().trim().max(50).optional(),
      bio: z.string().trim().max(160).optional(),
      website: z
        .string()
        .url()
        .max(200)
        .refine((v) => /^https?:/.test(v))
        .optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("event_update"),
      spaceId: delegationId,
      title: z.string().trim().min(1).max(120).optional(),
      description: z.string().trim().max(2000).optional(),
      scheduledAt: z.string().datetime().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("event_create"),
      title: z.string().trim().min(1).max(120),
      description: z.string().trim().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("feedback_update"),
      targetId: delegationId,
      status: z.enum(["new", "triaged", "resolved"]),
      adminNote: z.string().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("report_update"),
      targetId: delegationId,
      status: z.enum(["pending", "dismissed", "actionTaken"]),
      adminNote: z.string().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("verification_approve"),
      targetId: delegationId,
      adminNote: z.string().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("verification_reject"),
      targetId: delegationId,
      rejectionReason: z.string().trim().min(1).max(2000),
      adminNote: z.string().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("newsletter_create"),
      subject: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(12000),
      audienceFilters: newsletterAudienceFiltersSchema.default([]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("newsletter_send"),
      newsletterId: delegationId,
    })
    .strict(),
  z
    .object({
      operation: z.literal("export"),
      title: z.string().trim().min(1).max(100),
      format: z.enum(["markdown", "csv", "ics"]),
      body: z.string().min(1).max(32000),
    })
    .strict(),
]);
export type DelegatedActionInput = z.infer<typeof actionSchema>;
export const workflows = [
  {
    id: "news",
    title: "Sourced news",
    description: "Research, draft, edit and publish with source links.",
  },
  {
    id: "community",
    title: "Community follow-up",
    description:
      "Find unanswered posts and new members; prepare replies and introductions.",
  },
  {
    id: "retention",
    title: "Retention campaign",
    description: "Compare cohorts, prepare a campaign and measure later runs.",
  },
  {
    id: "personal",
    title: "Personal assistant",
    description: "Unread activity, saved posts, replies, profile and events.",
  },
  {
    id: "moderation",
    title: "Admin review",
    description: "Triage reports, feedback and verification requests.",
  },
  {
    id: "export",
    title: "Reports & exports",
    description:
      "Prepare issue drafts, reports, spreadsheets and calendar files.",
  },
];
export const workflowOperations: Record<string, string[]> = {
  news: [
    "post_publish",
    "post_draft",
    "post_draft_update",
    "post_update",
    "post_schedule",
    "export",
  ],
  community: ["post_publish", "post_draft", "export"],
  retention: [
    "newsletter_create",
    "newsletter_send",
    "post_publish",
    "post_draft",
    "export",
  ],
  personal: [
    "post_publish",
    "post_draft",
    "post_draft_update",
    "post_update",
    "post_schedule",
    "bookmark_save",
    "bookmark_collection",
    "profile_update",
    "event_create",
    "event_update",
    "export",
  ],
  moderation: [
    "feedback_update",
    "report_update",
    "verification_approve",
    "verification_reject",
    "export",
  ],
  export: ["export"],
};
