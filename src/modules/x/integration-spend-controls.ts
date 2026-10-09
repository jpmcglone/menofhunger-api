import type { IntegrationSpendControl } from "@prisma/client";
import type { IntegrationSpendPolicy } from "./integration-budget.policy";
import type { IntegrationBucket } from "./integration-budget.policy";

export function controlledPolicy(
  policy: IntegrationSpendPolicy,
  control: IntegrationSpendControl | null,
  bucket: IntegrationBucket,
  provider = "x",
): IntegrationSpendPolicy {
  if (!control) return policy;
  const lower = (ceiling: number, override: number | null) =>
    override === null ? ceiling : Math.min(ceiling, override);
  return {
    ...policy,
    enabled: policy.enabled && !control.paused,
    companyMonthlyMicros: lower(
      policy.companyMonthlyMicros,
      control.companyMonthlyMicros,
    ),
    companyDailyMicros: lower(
      policy.companyDailyMicros,
      control.companyDailyMicros,
    ),
    providerMonthlyMicros: lower(
      policy.providerMonthlyMicros,
      provider === "x" ? control.xMonthlyMicros : null,
    ),
    sharedMonthlyMicros:
      bucket === "reserve"
        ? lower(policy.sharedMonthlyMicros, control.reserveMonthlyMicros)
        : policy.sharedMonthlyMicros,
  };
}
