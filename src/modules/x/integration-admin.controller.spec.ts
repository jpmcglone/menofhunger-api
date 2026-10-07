import { IntegrationAdminController } from "./integration-admin.controller";
import { IntegrationAdminService } from "./integration-admin.service";
function fixture() {
  let control: any = null;
  const tx: any = {
    $executeRaw: jest.fn(),
    integrationSpendControl: {
      findUnique: jest.fn(async () => control),
      upsert: jest.fn(
        async ({ create, update }) =>
          (control = control ? { ...control, ...update } : create),
      ),
    },
    integrationControlAudit: { create: jest.fn() },
    integrationUsageReservation: {
      findUnique: jest.fn(async () => ({
        status: "uncertain",
        chargedMicros: null,
      })),
      update: jest.fn(),
    },
    integrationReconciliation: { create: jest.fn() },
  };
  const prisma: any = { $transaction: (fn: any) => fn(tx) };
  const config: any = {
    integrationBudget: () => ({
      companyMonthlyMicros: 100000000,
      companyDailyMicros: 10000000,
      providerMonthlyMicros: 80000000,
      sharedMonthlyMicros: 20000000,
    }),
  };
  return {
    controller: new IntegrationAdminController(
      new IntegrationAdminService(prisma, config),
    ),
    tx,
  };
}
const input = {
  expectedRevision: 0,
  reason: "Pause during invoice review",
  paused: true,
  companyMonthlyMicros: null,
  companyDailyMicros: 5000000,
  xMonthlyMicros: null,
  reserveMonthlyMicros: null,
};
describe("admin integration spending controls", () => {
  it("audits valid controls and rejects stale revision without a second write", async () => {
    const f = fixture();
    expect((await f.controller.controls("admin", input)).data.revision).toBe(1);
    await expect(f.controller.controls("admin", input)).rejects.toThrow(
      "changed",
    );
    expect(f.tx.integrationControlAudit.create).toHaveBeenCalledTimes(1);
  });
  it("cannot raise configured safety ceilings or omit a reason", async () => {
    const f = fixture();
    await expect(
      f.controller.controls("admin", {
        ...input,
        companyMonthlyMicros: 200000000,
      }),
    ).rejects.toThrow("ceiling");
    await expect(
      f.controller.controls("admin", { ...input, reason: "" }),
    ).rejects.toThrow();
    expect(f.tx.integrationSpendControl.upsert).not.toHaveBeenCalled();
  });
  it("records explicit microdollar charges with evidence and stale-outcome protection", async () => {
    const f = fixture();
    const body = {
      status: "released",
      chargedMicros: 15000,
      expectedStatus: "uncertain",
      evidence: "Confirmed provider invoice charge",
    };
    expect(
      (await f.controller.reconcile("admin", "operation", body)).data
        .chargedMicros,
    ).toBe(15000);
    expect(f.tx.integrationReconciliation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminUserId: "admin",
          previousStatus: "uncertain",
          chargedMicros: 15000,
        }),
      }),
    );
    await expect(
      f.controller.reconcile("admin", "operation", {
        ...body,
        expectedStatus: "reserved",
      }),
    ).rejects.toThrow("changed");
  });
});
