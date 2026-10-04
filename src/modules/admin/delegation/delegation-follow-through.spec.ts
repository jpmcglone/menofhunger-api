jest.mock("../../mcp/mcp-tools", () => ({
  sharedTools: { schema: () => ({}), sanitize: (value: unknown) => value },
}));
import { DelegationReadsService } from "./delegation-reads.service";
import { DelegationService } from "./delegation.service";
import { nextDelegationRun } from "./delegation.schedule";
import {
  scheduleSchema,
  jobControlSchema,
  jobEditSchema,
} from "./delegation.schemas";
import { DelegationSideEffectsHandler } from "./delegation-side-effects.handler";
import { DelegationGithubService } from "./delegation-github.service";
import { actionSubjectKey } from "./delegation-actions.service";

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
      job: {
        ownerId: "admin",
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

describe("reviewed GitHub issues", () => {
  const fetchOriginal = global.fetch;
  afterEach(() => {
    global.fetch = fetchOriginal;
  });
  const setup = () =>
    new DelegationGithubService(
      {
        delegationGithub: () => ({
          repository: "owner/repo",
          token: "test-token",
        }),
        frontendBaseUrl: () => "https://menofhunger.com",
      } as any,
      {
        feedback: { findUnique: jest.fn(async () => ({ id: "feedback" })) },
      } as any,
    );
  it("uses the configured repo and preserves the backlink", async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ number: 12 }),
    })) as any;
    expect(
      await setup().create({
        feedbackId: "feedback",
        title: "Fix issue",
        body: "Reviewed text",
      }),
    ).toEqual({
      receipt: "GitHub issue #12 created.",
      path: "https://github.com/owner/repo/issues/12",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("/admin/feedback?feedbackId=feedback"),
      }),
    );
  });
  it("does not retry an uncertain write", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("timeout");
    }) as any;
    await expect(
      setup().create({ feedbackId: "feedback", title: "Fix", body: "Text" }),
    ).rejects.toThrow("timeout");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it("does not send credentials to a supplied host", async () => {
    global.fetch = jest.fn() as any;
    await expect(setup().read("https://evil.com/issues/1")).rejects.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("keeps stable subject keys across job reruns and page switches for GitHub", () => {
    const input = {
      operation: "github_issue" as const,
      feedbackId: "f",
      title: "a",
      body: "a",
    };
    expect(actionSubjectKey("owner", "page1", input)).toBe(
      actionSubjectKey("owner", "page2", { ...input, title: "b" }),
    );
    expect(actionSubjectKey("other", "page1", input)).not.toBe(
      actionSubjectKey("owner", "page1", input),
    );
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
