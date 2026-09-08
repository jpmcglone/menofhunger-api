import { sharedTools } from "../../mcp/mcp-tools";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import type {
  DelegationAction,
  DelegationJob,
  DelegationRun,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AppConfigService } from "../../app/app-config.service";
import { PresenceRealtimeService } from "../../presence/presence-realtime.service";
import { JobsService } from "../../jobs/jobs.service";
import { JOBS } from "../../jobs/jobs.constants";
import { MarvinAIService } from "../../marvin/services/marvin-ai.service";
import { MarvinAdminService } from "../../marvin/services/marvin-admin.service";
import type {
  DelegationActionDto,
  DelegationJobDto,
  DelegationWorkspaceDto,
} from "../../../common/dto/delegation.dto";
import { DelegationPolicyService } from "./delegation-policy.service";
import { DelegationActionsService } from "./delegation-actions.service";
import {
  actionSchema,
  jobInputSchema,
  scheduleSchema,
  workflows,
  workflowOperations,
  type JobInput,
} from "./delegation.schemas";
import { nextDelegationRun } from "./delegation.schedule";

export const delegationJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value));
export const jobInclude = {
  actor: {
    select: { id: true, username: true, name: true, accountKind: true },
  },
  runs: {
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
    take: 20,
    include: { actions: { orderBy: { createdAt: "asc" as const } } },
  },
};
type FullJob = Prisma.DelegationJobGetPayload<{ include: typeof jobInclude }>;
export type RunSnapshot = Pick<
  DelegationJob,
  | "ownerId"
  | "actorId"
  | "title"
  | "workflow"
  | "instruction"
  | "permission"
  | "revision"
>;
@Injectable()
export class DelegationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: DelegationPolicyService,
    private readonly actions: DelegationActionsService,
    private readonly config: AppConfigService,
    private readonly realtime: PresenceRealtimeService,
    private readonly jobs: JobsService,
    private readonly ai: MarvinAIService,
    private readonly marv: MarvinAdminService,
  ) {}
  async configured() {
    return (
      this.ai.isConfigured() && (await this.marv.getGlobalSettings()).enabled
    );
  }
  async workspace(ownerId: string): Promise<DelegationWorkspaceDto> {
    const accounts = await this.policy.accounts(ownerId);
    const include = {
      ...jobInclude,
      runs: { ...jobInclude.runs, take: 1 },
      _count: {
        select: {
          runs: { where: { actions: { some: { status: "pending" } } } },
        },
      },
    };
    const groups = await Promise.all([
      this.prisma.delegationJob.findMany({
        where: { ownerId, status: { not: "cancelled" } },
        orderBy: { createdAt: "desc" },
        take: 30,
        include,
      }),
      this.prisma.delegationJob.findMany({
        where: { ownerId, status: "cancelled" },
        orderBy: { createdAt: "desc" },
        take: 20,
        include,
      }),
    ]);
    const jobs = groups
      .flat()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      configured: await this.configured(),
      access: "admin",
      actionSchema: sharedTools.schema(actionSchema),
      operations: workflowOperations,
      accounts,
      workflows,
      jobs: jobs.map((j) => ({
        ...this.dto(j),
        pendingCount: j._count.runs,
        runs: this.dto(j).runs.map((r) => ({
          ...r,
          summary: r.summary?.slice(0, 500) ?? null,
          actions: r.actions.map((a) => ({
            ...a,
            body: null,
            preview: a.preview.slice(0, 240),
          })),
        })),
      })),
      integrations: [
        {
          id: "news",
          title: "Web research",
          available:
            this.config.marvOpenAI().webSearchEnabled &&
            this.config.marvOpenAI().webSearchModes.includes("regular"),
          reason: "Uses the existing MARV web-search configuration.",
        },
        {
          id: "newsletter",
          title: "Men of Hunger email",
          available: Boolean(
            this.config.email() && this.config.newsletterPostalAddress(),
          ),
          reason:
            "Delivery requires the existing email and newsletter address configuration. Drafts are always available.",
        },
        ...[
          "GitHub",
          "Google Docs / Sheets",
          "External calendar",
          "External social accounts",
        ].map((title) => ({
          id: title,
          title,
          available: false,
          reason:
            "Direct integration skipped: no existing server connection. Download prepared exports instead.",
        })),
      ],
    };
  }
  async get(ownerId: string, id: string, before?: string) {
    await this.policy.assertAdmin(ownerId);
    const job = await this.prisma.delegationJob.findFirst({
      where: { id, ownerId },
      include: {
        ...jobInclude,
        runs: {
          ...jobInclude.runs,
          take: 21,
          ...(before ? { cursor: { id: before }, skip: 1 } : {}),
        },
      },
    });
    if (!job) throw new NotFoundException();
    const hasMore = job.runs.length > 20;
    job.runs = job.runs.slice(0, 20);
    return {
      ...this.dto(job),
      nextRunCursor: hasMore ? job.runs.at(-1)!.id : null,
    };
  }
  async create(ownerId: string, raw: unknown) {
    const input = jobInputSchema.parse(raw);
    const actor = await this.policy.actor(ownerId, input.actorUsername);
    const existing = await this.prisma.delegationJob.findUnique({
      where: { id: input.id },
    });
    if (existing) {
      if (existing.ownerId !== ownerId) throw new NotFoundException();
      if (
        existing.actorId !== actor.id ||
        existing.title !== input.title ||
        existing.instruction !== input.instruction ||
        existing.workflow !== input.workflow ||
        existing.permission !== input.permission ||
        !isDeepStrictEqual(existing.schedule, delegationJson(input.schedule))
      )
        throw new ConflictException("This request ID was already used.");
      return this.get(ownerId, existing.id);
    }
    if (
      (await this.prisma.delegationJob.count({
        where: { ownerId, status: { not: "cancelled" } },
      })) >= 30
    )
      throw new BadRequestException(
        "You can keep up to 30 active or paused jobs.",
      );
    this.validatePermission(input);
    const job = await this.prisma.delegationJob.create({
      data: {
        id: input.id,
        ownerId,
        actorId: actor.id,
        title: input.title,
        workflow: input.workflow,
        instruction: input.instruction,
        permission: input.permission,
        schedule: delegationJson(input.schedule),
        nextRunAt: nextDelegationRun(input.schedule, new Date()),
      },
    });
    this.notify(ownerId, job.id);
    if (job.nextRunAt && job.nextRunAt <= new Date()) await this.queueDue(job);
    return this.get(ownerId, job.id);
  }
  private validatePermission(input: JobInput) {
    if (
      input.permission === "publish_news" &&
      (!this.config.marvOpenAI().webSearchEnabled ||
        !this.config.marvOpenAI().webSearchModes.includes("regular"))
    )
      throw new BadRequestException(
        "Automatic news publishing needs the existing MARV web-search feature to be enabled. Choose review mode for now.",
      );
  }
  async edit(ownerId: string, id: string, revision: number, raw: unknown) {
    const input = jobInputSchema.parse({ ...(raw as object), id });
    const actor = await this.policy.actor(ownerId, input.actorUsername);
    this.validatePermission(input);
    const result = await this.prisma.delegationJob.updateMany({
      where: { id, ownerId, revision, status: { not: "cancelled" } },
      data: {
        title: input.title,
        workflow: input.workflow,
        instruction: input.instruction,
        actorId: actor.id,
        permission: input.permission,
        schedule: delegationJson(input.schedule),
        revision: { increment: 1 },
        nextRunAt: nextDelegationRun(input.schedule, new Date()),
      },
    });
    if (!result.count)
      throw new ConflictException("This job changed. Refresh before editing.");
    this.notify(ownerId, id);
    return this.get(ownerId, id);
  }
  async control(
    ownerId: string,
    id: string,
    command: "pause" | "resume" | "cancel" | "run",
    requestId: string,
  ) {
    const job = await this.prisma.delegationJob.findFirst({
      where: { id, ownerId },
    });
    if (!job) throw new NotFoundException();
    await this.policy.assertAdmin(ownerId);
    if (command === "run") {
      await this.policy.assertActor(ownerId, job.actorId);
      await this.queue(job, requestId);
    } else {
      if (job.status === "cancelled") return this.get(ownerId, id);
      if (command === "resume")
        await this.policy.assertActor(ownerId, job.actorId);
      const status =
        command === "pause"
          ? "paused"
          : command === "resume"
            ? "active"
            : "cancelled";
      await this.prisma.delegationJob.updateMany({
        where: { id, ownerId, revision: job.revision },
        data: {
          status,
          revision: { increment: 1 },
          nextRunAt:
            command === "resume"
              ? nextDelegationRun(
                  scheduleSchema.parse(job.schedule),
                  new Date(),
                )
              : null,
        },
      });
      if (command !== "resume") {
        await this.prisma.delegationRun.updateMany({
          where: { jobId: id, status: "queued" },
          data: { status: "cancelled", completedAt: new Date() },
        });
      }
    }
    this.notify(ownerId, id);
    return this.get(ownerId, id);
  }
  async queue(job: DelegationJob, requestKey: string) {
    if (job.status === "cancelled")
      throw new BadRequestException("This job is cancelled.");
    const existing = await this.prisma.delegationRun.findUnique({
      where: { requestKey },
    });
    if (existing) {
      if (existing.jobId !== job.id)
        throw new ConflictException("This request ID was already used.");
      return existing;
    }
    if (
      (await this.prisma.delegationRun.count({
        where: {
          job: { ownerId: job.ownerId },
          createdAt: { gte: new Date(Date.now() - 3600000) },
        },
      })) >= 30
    )
      throw new BadRequestException(
        "The hourly limit of 30 delegated runs has been reached.",
      );
    if (
      await this.prisma.delegationRun.count({
        where: { jobId: job.id, status: { in: ["queued", "running"] } },
      })
    )
      throw new ConflictException(
        "This job already has a queued or running task.",
      );
    const run = await this.prisma.delegationRun.create({
      data: {
        jobId: job.id,
        requestKey,
        jobSnapshot: delegationJson(this.snapshot(job)),
      },
    });
    await this.enqueue(run.id);
    this.notify(job.ownerId, job.id);
    return run;
  }
  async queueDue(job: DelegationJob) {
    if (!job.nextRunAt || job.status !== "active") return;
    const due = job.nextRunAt;
    if (
      (await this.prisma.delegationRun.count({
        where: {
          job: { ownerId: job.ownerId },
          createdAt: { gte: new Date(Date.now() - 3600000) },
        },
      })) >= 30
    )
      return;
    await this.policy.assertActor(job.ownerId, job.actorId);
    if (
      await this.prisma.delegationRun.count({
        where: { jobId: job.id, status: { in: ["queued", "running"] } },
      })
    )
      return;
    const next =
      job.schedule && scheduleSchema.parse(job.schedule).frequency !== "once"
        ? nextDelegationRun(
            scheduleSchema.parse(job.schedule),
            new Date(Math.max(Date.now(), due.getTime())),
          )
        : null;
    const run = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.delegationJob.updateMany({
        where: {
          id: job.id,
          status: "active",
          revision: job.revision,
          nextRunAt: due,
        },
        data: { nextRunAt: next },
      });
      if (!claimed.count) return null;
      return tx.delegationRun.create({
        data: {
          jobId: job.id,
          requestKey: `scheduled-${job.id}-${due.toISOString()}`,
          jobSnapshot: delegationJson(this.snapshot(job)),
        },
      });
    });
    if (run) {
      await this.enqueue(run.id);
      this.notify(job.ownerId, job.id);
    }
  }
  async enqueue(runId: string) {
    // The database is the durable outbox; the sweep retries queue delivery, never completed actions.
    try {
      await this.jobs.enqueue(
        JOBS.adminDelegationRun,
        { runId },
        {
          jobId: `delegation-${runId}`,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch {
      /* Recovered by the scheduler sweep. */
    }
  }
  snapshot(job: DelegationJob): RunSnapshot {
    const {
      ownerId,
      actorId,
      title,
      workflow,
      instruction,
      permission,
      revision,
    } = job;
    return {
      ownerId,
      actorId,
      title,
      workflow,
      instruction,
      permission,
      revision,
    };
  }
  async drafts(ownerId: string, jobId: string) {
    const job = await this.prisma.delegationJob.findFirst({
      where: { id: jobId, ownerId },
    });
    if (!job) throw new NotFoundException();
    await this.policy.assertActor(ownerId, job.actorId);
    return this.actions.drafts(job.actorId);
  }
  async prepare(
    ownerId: string,
    jobId: string,
    requestId: string,
    raw: unknown,
  ) {
    const job = await this.prisma.delegationJob.findFirst({
      where: { id: jobId, ownerId },
    });
    if (!job) throw new NotFoundException();
    await this.policy.assertActor(ownerId, job.actorId);
    if (job.status === "cancelled")
      throw new ConflictException("This job is cancelled.");
    const input = actionSchema.parse(raw);
    if (!workflowOperations[job.workflow]?.includes(input.operation))
      throw new BadRequestException(
        "This operation is outside the job’s permission.",
      );
    const existing = await this.prisma.delegationRun.findUnique({
      where: { requestKey: requestId },
      include: { actions: true },
    });
    if (existing) {
      if (
        existing.jobId !== jobId ||
        !isDeepStrictEqual(existing.actions[0]?.input, delegationJson(input))
      )
        throw new ConflictException("This request ID was already used.");
      return this.get(ownerId, jobId);
    }
    if (
      (await this.prisma.delegationRun.count({
        where: {
          job: { ownerId },
          createdAt: { gte: new Date(Date.now() - 3600000) },
        },
      })) >= 30
    )
      throw new BadRequestException(
        "The hourly limit of 30 delegated runs has been reached.",
      );
    const before = await this.actions.snapshot(job.actorId, input);
    await this.prisma.delegationRun.create({
      data: {
        jobId,
        requestKey: requestId,
        jobSnapshot: delegationJson(this.snapshot(job)),
        status: "review",
        summary: "A connected assistant prepared this action for your review.",
        completedAt: new Date(),
        actions: {
          create: {
            operation: input.operation,
            title: input.operation.replace(/_/g, " "),
            input: delegationJson(input),
            before: delegationJson(before),
          },
        },
      },
    });
    this.notify(ownerId, jobId);
    return this.get(ownerId, jobId);
  }
  async decide(
    ownerId: string,
    id: string,
    decision: "confirm" | "cancel",
    body?: string,
  ) {
    const action = await this.prisma.delegationAction.findFirst({
      where: { id, run: { job: { ownerId } } },
      include: { run: { include: { job: true } } },
    });
    if (!action) throw new NotFoundException();
    const job = action.run.job;
    await this.policy.assertActor(ownerId, job.actorId);
    if (action.status !== "pending") return this.actionDto(action);
    if (decision === "cancel") {
      await this.prisma.delegationAction.updateMany({
        where: { id, status: "pending" },
        data: { status: "cancelled", completedAt: new Date() },
      });
    } else {
      const snapshot = action.run.jobSnapshot as unknown as RunSnapshot;
      if (
        job.status === "cancelled" ||
        snapshot.revision !== job.revision ||
        action.run.status === "cancelled"
      )
        throw new ConflictException(
          "This job changed. Prepare a fresh run before applying its actions.",
        );
      const raw =
        body === undefined
          ? action.input
          : { ...(action.input as object), body };
      if (body !== undefined && !("body" in (action.input as object)))
        throw new BadRequestException(
          "This action does not have editable text.",
        );
      const input = actionSchema.parse(raw);
      if (!workflowOperations[job.workflow]?.includes(input.operation))
        throw new BadRequestException(
          "This operation is outside the job’s permission.",
        );
      const before = await this.actions.snapshot(job.actorId, input);
      if (!isDeepStrictEqual(delegationJson(before), action.before))
        throw new ConflictException(
          "This item changed. Run the job again to review a fresh proposal.",
        );
      const claimed = await this.prisma.delegationAction.updateMany({
        where: {
          id,
          status: "pending",
          run: {
            job: { revision: snapshot.revision, status: { not: "cancelled" } },
          },
        },
        data: {
          status: "applying",
          startedAt: new Date(),
          input: delegationJson(input),
        },
      });
      if (claimed.count) {
        try {
          await this.policy.assertActor(ownerId, job.actorId);
          const receipt = await this.actions.execute(
            ownerId,
            job.actorId,
            input,
          );
          await this.prisma.delegationAction.update({
            where: { id },
            data: { ...receipt, status: "complete", completedAt: new Date() },
          });
        } catch {
          await this.prisma.delegationAction.update({
            where: { id },
            data: {
              status: "uncertain",
              receipt:
                "The result could not be confirmed. Check the destination before taking further action.",
              completedAt: new Date(),
            },
          });
        }
      }
    }
    await this.settleRun(action.runId);
    this.notify(ownerId, job.id);
    return this.actionDto(
      await this.prisma.delegationAction.findUniqueOrThrow({ where: { id } }),
    );
  }
  async settleRun(runId: string) {
    const actions = await this.prisma.delegationAction.findMany({
      where: { runId },
      select: { status: true },
    });
    const status = actions.some(
      (a) => a.status === "uncertain" || a.status === "applying",
    )
      ? "uncertain"
      : actions.some((a) => a.status === "pending")
        ? "review"
        : "complete";
    await this.prisma.delegationRun.updateMany({
      where: { id: runId, status: { in: ["review", "complete", "uncertain"] } },
      data: { status },
    });
  }
  async export(ownerId: string, id: string) {
    await this.policy.assertAdmin(ownerId);
    const action = await this.prisma.delegationAction.findFirst({
      where: { id, operation: "export", run: { job: { ownerId } } },
    });
    if (!action) throw new NotFoundException();
    const input = actionSchema.parse(action.input);
    if (input.operation !== "export") throw new NotFoundException();
    return input;
  }
  notify(ownerId: string, id: string) {
    this.realtime.emitAdminUpdated(ownerId, {
      kind: "assistant",
      action: "updated",
      id,
    });
  }
  actionDto(a: DelegationAction): DelegationActionDto {
    const input = actionSchema.parse(a.input);
    let preview = Object.entries(input)
      .filter(([k]) => k !== "operation" && k !== "sources")
      .map(
        ([k, v]) =>
          `${k.replace(/([A-Z])/g, " $1")}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
      )
      .join("\n\n");
    const before = a.before as Record<string, unknown>;
    const context = ["subject", "name", "title", "body"]
      .filter((key) => typeof before[key] === "string")
      .map((key) => `${key}: ${before[key]}`)
      .join("\n");
    if (context) preview += `\n\nCurrent item:\n${context}`;
    if (Array.isArray(before.media) && before.media.length)
      preview += `\n\nAttached media: ${before.media.length} item(s), preserved from the selected draft.`;
    return {
      id: a.id,
      exportFormat: input.operation === "export" ? input.format : undefined,
      operation: a.operation,
      title: a.title,
      preview,
      body: "body" in input ? input.body : null,
      status: a.status,
      receipt: a.receipt,
      path: a.path,
      sources: "sources" in input ? input.sources : [],
      createdAt: a.createdAt.toISOString(),
    };
  }
  dto(j: FullJob): DelegationJobDto {
    return {
      id: j.id,
      title: j.title,
      workflow: j.workflow,
      instruction: j.instruction,
      permission: j.permission,
      actor: j.actor,
      schedule: scheduleSchema.parse(j.schedule),
      status: j.status,
      nextRunAt: j.nextRunAt?.toISOString() ?? null,
      revision: j.revision,
      createdAt: j.createdAt.toISOString(),
      runs: j.runs.map(
        (r: DelegationRun & { actions: DelegationAction[] }) => ({
          id: r.id,
          status: r.status,
          summary: r.summary,
          createdAt: r.createdAt.toISOString(),
          completedAt: r.completedAt?.toISOString() ?? null,
          actions: r.actions.map((a) => this.actionDto(a)),
        }),
      ),
    };
  }
}
