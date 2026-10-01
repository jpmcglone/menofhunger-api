import { Prisma } from "@prisma/client";

/** The database returns only aggregate scalars, never the month's ledger rows. */
export type SpendTotals = {
  company: number;
  daily: number;
  provider: number;
  bucket: number;
  analytics: number;
  publications: number;
  regular: number;
  expensive: number;
  pendingRegular: number;
  pendingExpensive: number;
};
type Query = Pick<Prisma.TransactionClient, "$queryRaw">;
const committed = Prisma.sql`CASE WHEN status='released' THEN COALESCE("chargedMicros",0)
  WHEN status='settled' THEN COALESCE("chargedMicros","reservedMicros")
  ELSE GREATEST("reservedMicros",COALESCE("chargedMicros",0)) END`;
function amount(value: bigint | number | null | undefined): number {
  const n = Number(value ?? 0);
  // Fail closed if accounting ever grows beyond JS's exact integer range.
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("Integration accounting total is out of range.");
  return n;
}
export async function spendTotals(
  db: Query,
  input: {
    month: Date;
    day: Date;
    excludeId?: string;
    provider: string;
    userId?: string;
    externalAccountId?: string;
    bucket: string;
  },
): Promise<SpendTotals> {
  const [row] = await db.$queryRaw<Array<Record<keyof SpendTotals, bigint>>>`
    /* integration:month */
    WITH args AS (SELECT ${input.month}::timestamp AS month, ${input.day}::timestamp AS day,
      ${input.excludeId ?? ""}::text AS excluded, ${input.provider}::text AS provider,
      ${input.userId ?? null}::text AS owner, ${input.externalAccountId ?? null}::text AS identity,
      ${input.bucket}::text AS bucket), entries AS (
      SELECT r.*, (${committed})::bigint AS cost,
        (r."userId"=a.owner OR (r.provider=a.provider AND r."externalAccountId"=a.identity)) IS TRUE AS own
      FROM "IntegrationUsageReservation" r CROSS JOIN args a WHERE r.month=a.month AND r.id<>a.excluded
    )
    SELECT COALESCE(SUM(cost),0)::bigint AS company,
      COALESCE(SUM(cost) FILTER (WHERE "createdAt">=a.day),0)::bigint AS daily,
      COALESCE(SUM(cost) FILTER (WHERE e.provider=a.provider),0)::bigint AS provider,
      COALESCE(SUM(cost) FILTER (WHERE e.bucket=a.bucket AND (a.bucket IN ('reserve','acquisition') OR own)),0)::bigint AS bucket,
      COALESCE(SUM(cost) FILTER (WHERE own AND action='analytics'),0)::bigint AS analytics,
      COALESCE(SUM("publicationCount") FILTER (WHERE own AND e.provider='x' AND status<>'released'),0)::bigint AS publications,
      COALESCE(SUM(cost) FILTER (WHERE own AND e.bucket='regular'),0)::bigint AS regular,
      COALESCE(SUM(cost) FILTER (WHERE own AND e.bucket='expensive'),0)::bigint AS expensive,
      COALESCE(SUM(cost) FILTER (WHERE own AND e.bucket='regular' AND status IN ('reserved','uncertain')),0)::bigint AS "pendingRegular",
      COALESCE(SUM(cost) FILTER (WHERE own AND e.bucket='expensive' AND status IN ('reserved','uncertain')),0)::bigint AS "pendingExpensive"
    FROM entries e CROSS JOIN args a`;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, amount(value)]),
  ) as SpendTotals;
}
export async function lifetimeSpend(
  db: Query,
  provider: string,
  action: string,
  excludeId: string,
) {
  const [row] = await db.$queryRaw<Array<{ cost: bigint; requests: bigint }>>`
    /* integration:lifetime */ SELECT COALESCE(SUM(${committed}),0)::bigint AS cost,
      COUNT(*) FILTER (WHERE status<>'released')::bigint AS requests
    FROM "IntegrationUsageReservation" WHERE provider=${provider} AND action=${action} AND id<>${excludeId}`;
  return { cost: amount(row.cost), requests: amount(row.requests) };
}
