jest.mock("../../mcp/mcp-tools", () => ({
  sharedTools: { schema: () => ({}), sanitize: (value: unknown) => value },
}));
import { DelegationReadsService } from "./delegation-reads.service";
import { DelegationService } from "./delegation.service";
import { nextDelegationRun } from "./delegation.schedule";
import {
  actionSchema,
  workflowOperations,
  scheduleSchema,
  jobControlSchema,
  jobEditSchema,
} from "./delegation.schemas";
import { DelegationSideEffectsHandler } from "./delegation-side-effects.handler";

describe("extended schedules", () => {
  const next = (s: object, after: string) =>
    nextDelegationRun(
      scheduleSchema.parse(s),
      new Date(after),
    )?.toISOString() ?? null;
  it("skips weekends for selected weekdays", () =>
    expect(
      next(
        { frequency: "daily", weekdays: [1, 2, 3, 4, 5] },
        "2026-10-02T12:00:00Z",
      ),
    ).toBe("2026-10-05T12:00:00.000Z"));
  it("allows several weekly days without applying the legacy weekday default", () =>
    expect(
      next({ frequency: "weekly", weekdays: [2, 4] }, "2026-10-05T12:00:00Z"),
    ).toBe("2026-10-06T12:00:00.000Z"));
  it("skips months without the requested day", () =>
    expect(
      next({ frequency: "monthly", dayOfMonth: 31 }, "2026-04-01T00:00:00Z"),
    ).toBe("2026-05-31T12:00:00.000Z"));
  it("does not run past the end", () =>
    expect(
      next(
        { frequency: "daily", endsAt: "2026-10-04T11:00:00Z" },
        "2026-10-03T12:00:00Z",
      ),
    ).toBeNull());
  it("does not run a one-shot beyond its end", () =>
    expect(
      next(
        {
          frequency: "once",
          at: "2026-10-10T00:00:00Z",
          endsAt: "2026-10-05T00:00:00Z",
        },
        "2026-10-03T12:00:00Z",
      ),
    ).toBeNull());
  it("skips the spring DST gap", () =>
    expect(
      next({ frequency: "daily", time: "02:30" }, "2026-03-07T07:30:00Z"),
    ).toBe("2026-03-09T06:30:00.000Z"));
  it("does not repeat the fall DST minute", () =>
    expect(
      next({ frequency: "daily", time: "01:30" }, "2026-11-01T05:30:00Z"),
    ).toBe("2026-11-02T06:30:00.000Z"));
  it("rejects empty weekdays, invalid zones, and unbounded cooldowns", () => {
    for (const schedule of [
      { weekdays: [] },
      { timeZone: "fake/zone" },
      {
        condition: {
          metric: "pending_reports",
          threshold: 1,
          cooldownHours: 0,
        },
      },
    ])
      expect(
        scheduleSchema.safeParse({ frequency: "daily", ...schedule }).success,
      ).toBe(false);
  });
  it("allows partial edits while rejecting unexpected permission fields", () => {
    expect(
      jobEditSchema.parse({ revision: 2, changes: { title: "Renamed" } })
        .changes,
    ).toEqual({ title: "Renamed" });
    expect(
      jobEditSchema.safeParse({ revision: 2, changes: { ownerId: "other" } })
        .success,
    ).toBe(false);
    expect(
      jobControlSchema.parse({
        command: "skip",
        requestId: "4e747181-b709-4e7f-a611-228226f00184",
      }).command,
    ).toBe("skip");
  });
});

describe("durable result delivery", () => {
  function setup(mode = "actionable", status = "review") {
    const run: any = {
      id: "run",
      jobId: "job",
      status,
      notifiedAt: null,
      notificationKey: null,
      jobSnapshot: { revision: 1, schedule: { notification: mode } },
      job: {
        ownerId: "admin",
        revision: 1,
        status: "active",
        schedule: { frequency: "daily", notification: mode },
        owner: { siteAdmin: true, bannedAt: null },
      },
    };
    const prisma: any = {
      delegationRun: {
        findUnique: jest.fn(async () => run),
        update: jest.fn(async ({ data }) => Object.assign(run, data)),
        findMany: jest.fn(async () => [run]),
        updateMany: jest.fn(async ({ data }) => Object.assign(run, data)),
      },
    };
    const notifications: any = { create: jest.fn() };
    const handler = new DelegationSideEffectsHandler(
      prisma,
      { register: jest.fn() } as any,
      notifications,
      { withLock: async (_k: string, _o: any, fn: any) => fn() } as any,
    );
    return { handler, run, notifications, prisma };
  }
  it.each(["failed", "review", "complete", "uncertain"])(
    "never replays historical %s runs after notification settings are enabled",
    async (status) => {
      const { handler, notifications, run } = setup("all", status);
      run.jobSnapshot = { revision: 1 }; // exact shape stored before the rollout
      await handler.deliver("run");
      expect(notifications.create).not.toHaveBeenCalled();
      expect(run.notifiedAt).toBeTruthy();
    },
  );
  it("requires explicit notification settings at run creation", async () => {
    const { handler, notifications, run } = setup("all");
    run.jobSnapshot.schedule = { frequency: "daily" };
    await handler.deliver("run");
    expect(notifications.create).not.toHaveBeenCalled();
  });
  it.each(["cancelled", "superseded"])(
    "stays quiet for %s work",
    async (state) => {
      const { handler, notifications, run } = setup();
      if (state === "cancelled") run.job.status = "cancelled";
      else run.job.revision = 2;
      await handler.deliver("run");
      expect(notifications.create).not.toHaveBeenCalled();
    },
  );
  it("does not enable delivery when a formerly muted run is edited", async () => {
    const { handler, notifications, run } = setup("all");
    run.jobSnapshot.schedule.notification = "none";
    await handler.deliver("run");
    expect(notifications.create).not.toHaveBeenCalled();
  });
  it.each(["review", "failed", "uncertain"])(
    "delivers %s once with the job link",
    async (status) => {
      const { handler, notifications } = setup("actionable", status);
      await handler.deliver("run");
      await handler.deliver("run");
      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          actionPath: "/admin/delegation/job",
          recipientUserId: "admin",
          kind: "generic",
        }),
      );
    },
  );
  it("stays quiet for a routine completion and muted jobs", async () => {
    for (const [mode, status] of [
      ["actionable", "complete"],
      ["none", "failed"],
    ]) {
      const { handler, notifications, run } = setup(mode, status);
      await handler.deliver("run");
      expect(notifications.create).not.toHaveBeenCalled();
      expect(run.notifiedAt).toBeTruthy();
    }
  });
  it("rechecks revoked administrator access", async () => {
    const { handler, notifications, run } = setup();
    run.job.owner.siteAdmin = false;
    await handler.deliver("run");
    expect(notifications.create).not.toHaveBeenCalled();
  });
  it("leaves delivery pending after a notification failure", async () => {
    const { handler, notifications, run } = setup();
    notifications.create.mockRejectedValue(new Error("offline"));
    await expect(handler.deliver("run")).rejects.toThrow();
    expect(run.notifiedAt).toBeNull();
  });
  it("excludes historical runs from an opted-in job's digest batch", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-04T13:00:00Z"));
    try {
      const { handler, run, prisma, notifications } = setup(
        "digest",
        "complete",
      );
      const historical = {
        ...run,
        id: "historical",
        jobSnapshot: { revision: 1 },
      };
      prisma.delegationRun.findMany.mockResolvedValue([historical, run]);
      await handler.deliver("run");
      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(prisma.delegationRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ["run"] } } }),
      );
    } finally {
      jest.useRealTimers();
    }
  });
  it("batches digest results only during the daily delivery hour", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-04T12:00:00Z"));
    try {
      const { handler, notifications, run } = setup("digest", "complete");
      await handler.deliver("run");
      expect(notifications.create).not.toHaveBeenCalled();
      jest.setSystemTime(new Date("2026-10-04T13:00:00Z"));
      await handler.deliver("run");
      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(run.notifiedAt).toBeTruthy();
      await handler.deliver("run");
      expect(notifications.create).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("job lifecycle follow-through", () => {
  function setup() {
    const job: any = {
      id: "4e747181-b709-4e7f-a611-228226f00184",
      ownerId: "admin",
      actorId: "page",
      title: "Original",
      instruction: "Review community",
      workflow: "community",
      permission: "review",
      revision: 3,
      status: "active",
      schedule: scheduleSchema.parse({ frequency: "daily" }),
      nextRunAt: new Date(Date.now() + 86400000),
    };
    const prisma: any = {
      delegationJob: {
        findFirst: jest.fn(async () => job),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      delegationAction: { updateMany: jest.fn() },
      delegationRun: { updateMany: jest.fn() },
    };
    const policy: any = {
      assertAdmin: jest.fn(),
      assertActor: jest.fn(async () => ({ id: "page", username: "mohnews" })),
      actor: jest.fn(async () => ({ id: "page" })),
    };
    const service = new DelegationService(
      prisma,
      policy,
      {} as any,
      {} as any,
      { emitAdminUpdated: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service, "get").mockResolvedValue(job);
    return { job, prisma, service, policy };
  }
  it("preserves actor, workflow and permission when a conversational edit only renames the job", async () => {
    const { job, prisma, service, policy } = setup();
    await service.edit("admin", job.id, 3, { changes: { title: "Renamed" } });
    expect(policy.actor).toHaveBeenCalledWith("admin", "mohnews");
    expect(prisma.delegationJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Renamed",
          actorId: "page",
          workflow: "community",
          permission: "review",
        }),
      }),
    );
    expect(
      prisma.delegationAction.updateMany.mock.calls[0][0].where.run.jobSnapshot,
    ).toEqual({ path: ["revision"], lte: 3 });
  });
  it("rejects stale controls before changing any job or proposal", async () => {
    const { job, prisma, service } = setup();
    await expect(
      service.control("admin", job.id, "skip", "request", 2),
    ).rejects.toThrow("changed");
    expect(prisma.delegationJob.updateMany).not.toHaveBeenCalled();
    expect(prisma.delegationAction.updateMany).not.toHaveBeenCalled();
  });
  it("skips only the selected occurrence and checks the concurrency claim", async () => {
    const { job, prisma, service } = setup();
    await service.control("admin", job.id, "skip", "request", 3);
    const change = prisma.delegationJob.updateMany.mock.calls[0][0];
    expect(change.where.nextRunAt).toEqual(job.nextRunAt);
    expect(change.data.nextRunAt.getTime()).toBeGreaterThan(
      job.nextRunAt.getTime(),
    );
    prisma.delegationJob.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.control("admin", job.id, "skip", "request", 3),
    ).rejects.toThrow("changed");
  });
  it("persists a timed pause and cancels queued work from the old revision", async () => {
    const { job, prisma, service } = setup();
    const resumeAt = new Date(Date.now() + 86400000).toISOString();
    await service.control("admin", job.id, "pause", "request", 3, resumeAt);
    expect(prisma.delegationJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "paused",
          resumeAt: new Date(resumeAt),
          nextRunAt: null,
        }),
      }),
    );
    expect(prisma.delegationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "queued",
          jobSnapshot: { path: ["revision"], lte: 3 },
        }),
      }),
    );
    await expect(
      service.control(
        "admin",
        job.id,
        "pause",
        "request",
        3,
        "2020-01-01T00:00:00Z",
      ),
    ).rejects.toThrow("future");
  });
});

describe("bounded investigative reads", () => {
  const setup = () => {
    const policy = { assertAdmin: jest.fn() };
    const operations = {
      content: jest.fn(async () => ({
        data: [],
        pagination: { nextCursor: "next" },
      })),
    };
    const service = new DelegationReadsService(
      policy as any,
      operations as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { policy, operations, service };
  };
  it("rechecks admin access and preserves a paginated investigation window", async () => {
    const { policy, operations, service } = setup();
    const result = await service.read("admin", "community", {
      area: "content",
      cursor: "previous",
      since: "2026-09-01T00:00:00Z",
      before: "2026-10-01T00:00:00Z",
      limit: 10,
    });
    expect(policy.assertAdmin).toHaveBeenCalledWith("admin");
    expect(operations.content).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: "previous",
        limit: 10,
        since: "2026-09-01T00:00:00Z",
        before: "2026-10-01T00:00:00Z",
      }),
    );
    expect(result).toMatchObject({ pagination: { nextCursor: "next" } });
  });
  it("rejects revoked access, oversized reads and reads outside the workflow", async () => {
    const { policy, operations, service } = setup();
    await expect(
      service.read("admin", "news", { area: "content" }),
    ).rejects.toThrow("outside");
    await expect(
      service.read("admin", "operations", { area: "content", limit: 500 }),
    ).rejects.toThrow();
    policy.assertAdmin.mockRejectedValue(new Error("revoked"));
    await expect(
      service.read("admin", "operations", { area: "content" }),
    ).rejects.toThrow("revoked");
    expect(operations.content).not.toHaveBeenCalled();
  });
});

describe("removed GitHub integration", () => {
  it("rejects GitHub actions in every workflow", () => {
    expect(
      actionSchema.safeParse({
        operation: "github_issue",
        feedbackId: "f",
        title: "Issue",
        body: "Body",
      }).success,
    ).toBe(false);
    for (const operations of Object.values(workflowOperations))
      expect(operations).not.toContain("github_issue");
  });
  it("preserves historical receipts without offering pending issues for approval", () => {
    const service = Object.create(
      DelegationService.prototype,
    ) as DelegationService;
    const result = service.actionDto({
      id: "old",
      operation: "github_issue",
      title: "Old issue",
      input: {},
      status: "pending",
      receipt: null,
      path: null,
      createdAt: new Date(),
    } as any);
    expect(result.status).toBe("cancelled");
    expect(result.preview).toContain("Linear");
  });
});
