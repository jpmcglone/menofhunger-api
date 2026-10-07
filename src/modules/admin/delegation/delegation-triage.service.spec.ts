import { DelegationTriageService } from "./delegation-triage.service";

function makeService(opts: { configured?: boolean; triage?: boolean; decide?: jest.Mock } = {}) {
  const typeSafe: any = {
    isConfigured: () => opts.configured ?? true,
    decide: opts.decide ?? jest.fn(async () => null),
  };
  const appConfig: any = { typeSafe: () => ({ triageEnabled: opts.triage ?? true }) };
  const prisma: any = {
    report: { findMany: jest.fn(async () => [{ id: "r1", details: "he threatened me" }]) },
  };
  return { svc: new DelegationTriageService(prisma, typeSafe, appConfig), typeSafe, prisma };
}

const feedbackAnswers = (over: Record<string, unknown> = {}) => ({
  answers: {
    category: { choice: "bug", confidence: 0.9 },
    urgency: { score: 0.2, confidence: 0.9 },
    needsHuman: { noul: 0.1 },
    ...over,
  },
});

describe("DelegationTriageService", () => {
  it("returns nothing without Jev, so the run is unchanged", async () => {
    const off = makeService({ configured: false });
    await expect(off.svc.hints({ feedback: [{ id: "f1" }] })).resolves.toBeNull();
    const disabled = makeService({ triage: false });
    await expect(disabled.svc.hints({ feedback: [{ id: "f1" }] })).resolves.toBeNull();
    expect(off.typeSafe.decide).not.toHaveBeenCalled();
    expect(disabled.typeSafe.decide).not.toHaveBeenCalled();
  });

  it("returns nothing when there is nothing to triage or every call fails", async () => {
    const { svc } = makeService();
    await expect(svc.hints({ feedback: [], reports: [] })).resolves.toBeNull();
    await expect(svc.hints({ feedback: [{ id: "f1", subject: "x", details: "y" }] })).resolves.toBeNull();
  });

  it("keeps routine, confident feedback off the escalation list", async () => {
    const decide = jest.fn(async () => feedbackAnswers());
    const { svc } = makeService({ decide });
    const hints = await svc.hints({ feedback: [{ id: "f1", subject: "Crash", details: "app crashes" }] });
    expect(hints?.items[0]).toMatchObject({ kind: "feedback", id: "f1", category: "bug", urgency: "routine", escalate: false, lowConfidence: false });
    expect(hints?.counts).toEqual({ total: 1, escalate: 0, lowConfidence: 0 });
  });

  it("escalates urgent, human-needed, and low-confidence items", async () => {
    const answers: Record<string, any> = {
      urgent: feedbackAnswers({ urgency: { score: 2.4, confidence: 0.9 } }),
      human: feedbackAnswers({ needsHuman: { noul: 0.8 } }),
      unsure: feedbackAnswers({ category: { choice: "other", confidence: 0.3 } }),
    };
    const decide = jest.fn(async ({ state }: any) => answers[state.subject]);
    const { svc } = makeService({ decide });
    const hints = await svc.hints({
      feedback: [
        { id: "a", subject: "urgent", details: "" },
        { id: "b", subject: "human", details: "" },
        { id: "c", subject: "unsure", details: "" },
      ],
    });
    const byId = Object.fromEntries((hints?.items ?? []).map((h) => [h.id, h]));
    expect(byId.a).toMatchObject({ urgency: "urgent", escalate: true });
    expect(byId.b).toMatchObject({ escalate: true, lowConfidence: false });
    expect(byId.c).toMatchObject({ escalate: true, lowConfidence: true });
  });

  it("escalates a report with possible serious harm and sends its details to Jev", async () => {
    const decide = jest.fn(async () => ({
      answers: {
        category: { choice: "violence", confidence: 0.9 },
        urgency: { score: 1.1, confidence: 0.9 },
        validViolation: { noul: 0.9 },
        seriousHarm: { noul: 0.6 },
        needsHuman: { noul: 0.2 },
      },
    }));
    const { svc, prisma } = makeService({ decide });
    const hints = await svc.hints({ reports: [{ id: "r1", reason: "violence" }] });
    expect(prisma.report.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["r1"] } } }));
    expect((decide.mock.calls[0] as any[])[0].state).toEqual({ reportedFor: "violence", reporterDetails: "he threatened me" });
    expect(hints?.items[0]).toMatchObject({ kind: "report", escalate: true, seriousHarm: 0.6 });
  });
});
