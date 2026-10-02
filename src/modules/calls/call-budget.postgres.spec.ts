import { PrismaClient } from '@prisma/client';
import { CallBudgetService, CALL_BUDGET_BYTES, reservationMonths } from './call-budget.service';

const url = process.env.CALL_BUDGET_FIXTURE_DATABASE_URL;
const databaseTests = url ? describe : describe.skip;
databaseTests('durable call budget (isolated PostgreSQL)', () => {
  let db: PrismaClient;
  beforeAll(() => { db = new PrismaClient({ datasources: { db: { url: url! } } }); });
  const config = { callsBudgetBytesPerSecond: () => 1_000_000 };
  const service = () => new CallBudgetService(db as never, config as never);
  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE "CallBudgetLease", "CallBudgetMonth"`;
  });
  afterAll(async () => { await db.$disconnect(); });

  it('atomically admits only funded calls across independent instances', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const oneCall = 1_000_000n * 16n * 180n;
    await db.$executeRaw`INSERT INTO "CallBudgetMonth" VALUES (${month}, ${CALL_BUDGET_BYTES - oneCall})`;
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => service().reserve(`call-${i}`, 4)));
    expect(results.filter(r => 'expiresAt' in r)).toHaveLength(1);
    expect(results.filter(r => 'error' in r && r.error === 'budget_exhausted')).toHaveLength(11);
    const [row] = await db.$queryRaw<Array<{ reservedBytes: bigint }>>`SELECT "reservedBytes" FROM "CallBudgetMonth"`;
    expect(row.reservedBytes).toBe(CALL_BUDGET_BYTES);
  });

  it('reuses a durable reservation across process instances without charging twice', async () => {
    const first = await service().reserve('same-call', 2);
    const again = await service().reserve('same-call', 2);
    expect(again).toEqual(first);
    const [row] = await db.$queryRaw<Array<{ reservedBytes: bigint }>>`SELECT "reservedBytes" FROM "CallBudgetMonth"`;
    expect(row.reservedBytes).toBe(1_000_000n * 4n * 180n);
    expect(await service().allowsAllocation('same-call')).toBe(true);
  });

  it('never resurrects expired leases or enlarges capacity under an existing reservation', async () => {
    await service().reserve('expired', 2);
    expect(await service().reserve('expired', 4)).toEqual({ error: 'calling_unavailable' });
    await db.$executeRaw`UPDATE "CallBudgetLease" SET "expiresAt" = clock_timestamp() - interval '1 second'`;
    expect(await service().reserve('expired', 2)).toEqual({ error: 'budget_exhausted' });
    expect(await service().allowsAllocation('expired')).toBe(false);
  });

  it('blocks new media in the warning interval', async () => {
    await service().reserve('warning', 4);
    await db.$executeRaw`UPDATE "CallBudgetLease" SET "expiresAt" = clock_timestamp() + interval '30 seconds'`;
    expect(await service().allowsAllocation('warning')).toBe(false);
  });
});

describe('budget failure policy', () => {
  it('reserves both UTC months when cleanup crosses rollover', () => {
    expect(reservationMonths(new Date('2026-12-31T23:57:30Z'), new Date('2026-12-31T23:59:30Z'))).toEqual(['2026-12', '2027-01']);
    expect(reservationMonths(new Date('2027-01-01T00:00:00Z'), new Date('2027-01-01T00:02:00Z'))).toEqual(['2027-01']);
  });
  it('blocks spending while accounting is unavailable', async () => {
    const db = { $transaction: async () => { throw new Error('offline'); }, $queryRaw: async () => { throw new Error('offline'); } };
    const budget = new CallBudgetService(db as never, { callsBudgetBytesPerSecond: () => 1 } as never);
    expect(await budget.reserve('call', 2)).toEqual({ error: 'calling_unavailable' });
    expect(await budget.allowsAllocation('call')).toBe(false);
  });
  it('requires an independently verified traffic bound', async () => {
    const budget = new CallBudgetService({} as never, { callsBudgetBytesPerSecond: () => null } as never);
    expect(await budget.reserve('call', 2)).toEqual({ error: 'calling_unavailable' });
  });
});
