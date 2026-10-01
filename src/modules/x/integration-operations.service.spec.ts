import { spendingAlerts } from "./integration-operations.service";
import { controlledPolicy } from "./integration-spend-controls";
const policy = {
  enabled: true,
  priceVersion: "verified",
  companyMonthlyMicros: 100,
  companyDailyMicros: 50,
  providerMonthlyMicros: 100,
  sharedMonthlyMicros: 20,
};
describe("integration operational controls", () => {
  it("cannot raise configuration ceilings and pauses spending without modifying prices", () => {
    const control = {
      paused: true,
      companyMonthlyMicros: 1000,
      companyDailyMicros: 10,
      xMonthlyMicros: null,
      reserveMonthlyMicros: 0,
    } as any;
    expect(controlledPolicy(policy, control, "reserve")).toEqual({
      ...policy,
      enabled: false,
      companyDailyMicros: 10,
      sharedMonthlyMicros: 0,
    });
    expect(
      controlledPolicy(policy, control, "regular").sharedMonthlyMicros,
    ).toBe(20);
  });
  it("warns at 80 percent and escalates exhausted or reduced ceilings", () => {
    expect(
      spendingAlerts(
        { company: 80, daily: 50, provider: 0, bucket: 0 },
        policy,
      ),
    ).toEqual([
      expect.objectContaining({ key: "company-month", severity: "warning" }),
      expect.objectContaining({ key: "company-day", severity: "error" }),
    ]);
    expect(
      spendingAlerts({ company: 0, daily: 0, provider: 0, bucket: 0 }, policy),
    ).toEqual([]);
  });
});
