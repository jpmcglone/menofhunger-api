import { JobsStatusService } from "../../jobs/jobs-status.service";
import { Injectable, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { AdminOperationsController } from "../admin-operations.controller";
import { IntegrationAdminController } from "../../x/integration-admin.controller";
import { AdminEngagementService } from "../admin-engagement.service";
import { PrismaService } from "../../prisma/prisma.service";
import { LandingService } from "../../landing/landing.service";
import { readAdminAnalytics } from "../admin-analytics.read";
import { DelegationPolicyService } from "./delegation-policy.service";
import { sharedTools } from "../../mcp/mcp-tools";
import { DelegationGithubService } from "./delegation-github.service";
import { delegationId } from "./delegation.schemas";

const schema = z
  .object({
    area: z.enum([
      "attention",
      "activation",
      "health",
      "content",
      "analytics",
      "integration_spending",
      "integration_operations",
      "feedback",
      "github_issues",
      "queues",
    ]),
    cursor: delegationId.optional(),
    offset: z.number().int().min(0).max(10000).default(0),
    limit: z.number().int().min(1).max(50).default(20),
    range: z.enum(["7d", "30d", "3m"]).default("30d"),
    since: z.string().datetime().optional(),
    before: z.string().datetime().optional(),
  })
  .strict();
const allowed: Record<string, string[]> = {
  operations: schema.shape.area.options,
  retention: ["attention", "activation", "analytics", "content"],
  community: ["attention", "activation", "content"],
  moderation: ["attention", "health", "feedback", "github_issues"],
  export: schema.shape.area.options,
  personal: [],
  news: [],
};
/** Reuses canonical controller reads without minting or retaining an admin session.
 * Every call rechecks the owner and workflow before invoking a read-only method. */
@Injectable()
export class DelegationReadsService {
  constructor(
    private readonly policy: DelegationPolicyService,
    private readonly operations: AdminOperationsController,
    private readonly integrations: IntegrationAdminController,
    private readonly engagement: AdminEngagementService,
    private readonly prisma: PrismaService,
    private readonly landing: LandingService,
    private readonly github: DelegationGithubService,
    private readonly jobs: JobsStatusService,
  ) {}
  tool(workflow: string) {
    return {
      type: "function",
      name: "read_admin",
      description: `Read live evidence. Available areas: ${(allowed[workflow] ?? []).join(", ")}. Lists are bounded; use returned cursors with unchanged time windows. No mutations.`,
      strict: false,
      parameters: sharedTools.schema(schema),
    };
  }
  async read(ownerId: string, workflow: string, raw: unknown) {
    await this.policy.assertAdmin(ownerId);
    const q = schema.parse(raw);
    if (!allowed[workflow]?.includes(q.area))
      throw new BadRequestException("This read is outside the job workflow.");
    let result: unknown;
    switch (q.area) {
      case "queues":
        result = { data: await this.jobs.getQueuesHealth() };
        break;
      case "attention":
        result = { data: await this.engagement.attention() };
        break;
      case "health":
        result = { data: await this.engagement.health() };
        break;
      case "activation":
        result = {
          data: await this.engagement.activation({
            days: 30,
            offset: q.offset,
            limit: q.limit,
          }),
        };
        break;
      case "analytics":
        result = await readAdminAnalytics(this.prisma, this.landing, q.range);
        break;
      case "content":
        result = await this.operations.content({
          limit: q.limit,
          cursor: q.cursor,
          since: q.since,
          before: q.before,
          unanswered: "true",
        });
        break;
      case "integration_spending":
        result = await this.integrations.spend({});
        break;
      case "integration_operations":
        result = await this.integrations.operations();
        break;
      case "github_issues": {
        const actions = await this.prisma.delegationAction.findMany({
          where: {
            operation: "github_issue",
            status: "complete",
            run: { job: { ownerId } },
          },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: { path: true, input: true },
        });
        result = {
          data: await Promise.all(
            actions.map(async (a) => ({
              feedbackId: (a.input as { feedbackId: string }).feedbackId,
              ...(a.path
                ? await this.github.read(a.path)
                : { available: false }),
            })),
          ),
          coverage:
            "Latest ten issued feedback items; closure is reported, not automatically marked resolved.",
        };
        break;
      }
      case "feedback": {
        const rows = await this.prisma.feedback.findMany({
          where: { status: { in: ["new", "triaged"] } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
          take: q.limit + 1,
          select: {
            id: true,
            subject: true,
            details: true,
            status: true,
            adminNote: true,
            updatedAt: true,
          },
        });
        result = {
          data: rows.slice(0, q.limit),
          pagination: {
            nextCursor: rows.length > q.limit ? rows[q.limit - 1].id : null,
          },
        };
        break;
      }
    }
    return sharedTools.sanitize({
      ...(result as object),
      asOf: new Date().toISOString(),
      coverage:
        "Bounded read. Follow pagination when present; do not interpret a preview as the full population.",
    });
  }
  async metrics(ownerId: string) {
    await this.policy.assertAdmin(ownerId);
    const [attention, integrations, health] = await Promise.all([
      this.engagement.attention(),
      this.integrations.operations(),
      this.engagement.health(),
    ]);
    const oldest = attention.pulse.oldestVerificationRequestedAt;
    return {
      verification_wait_hours: oldest
        ? (Date.now() - Date.parse(oldest)) / 3600000
        : 0,
      pending_reports: health.pendingReports,
      open_feedback: health.feedback.new + health.feedback.triaged,
      integration_alerts: integrations.data.alerts.length,
    };
  }
}
