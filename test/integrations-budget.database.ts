import 'reflect-metadata';
import assert = require('node:assert/strict');
import { PrismaClient } from '@prisma/client';
import { IntegrationBudgetService, type IntegrationSpendPolicy } from '../src/modules/x/integration-budget.service';
import type { PrismaService } from '../src/modules/prisma/prisma.service';

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/moh_partner_fixture');
  const db = new PrismaClient();
  const now = new Date('2099-01-15T12:00:00Z');
  const policy: IntegrationSpendPolicy = { enabled: true, priceVersion: 'synthetic', companyMonthlyMicros: 100_000_000,
    companyDailyMicros: 100_000_000, providerMonthlyMicros: 100_000_000, sharedMonthlyMicros: 1_000_000 };
  try {
    const owner = await db.user.create({ data: { verifiedStatus: 'manual', premium: true, premiumPlus: true } });
    const other = await db.user.create({ data: { verifiedStatus: 'manual', premium: true, premiumPlus: true } });
    const service = new IntegrationBudgetService(db as unknown as PrismaService);
    const input = { id: 'fixture-spend', userId: owner.id, externalAccountId: 'fixture-x', provider: 'x' as const,
      action: 'create', bucket: 'regular' as const, maximumMicros: 2_000_000, publicationCount: 1 };
    const raced = await Promise.all(Array.from({ length: 12 }, (_, index) => service.reserve({ ...input, id: `fixture-spend-${index}` }, policy, now)));
    assert.equal(raced.filter(Boolean).length, 4, 'concurrent workers cannot exceed $8');
    assert.equal(await service.reserve({ ...input, id: 'fixture-account-switch', userId: other.id }, policy, now), false);
    assert.equal(await service.reserve({ ...input, id: 'fixture-identity-switch', externalAccountId: 'another-x' }, policy, now), false);
    const same = { ...input, id: 'fixture-same-operation', bucket: 'expensive' as const, maximumMicros: 200_000 };
    const duplicates = await Promise.all(Array.from({ length: 8 }, () => service.reserve(same, policy, now)));
    assert.equal(duplicates.filter(Boolean).length, 1, 'one operation authorizes one worker');
    await service.settle(same.id, 'uncertain');
    assert.equal(await service.reserve(same, policy, now), false, 'uncertain creates cannot resend');
    const shared = { ...input, userId: undefined, externalAccountId: undefined, action: 'profileRead', bucket: 'reserve' as const, publicationCount: 0, maximumMicros: 200_000 };
    const publicReads = await Promise.all(Array.from({ length: 8 }, (_, index) => service.reserve({ ...shared, id: `fixture-public-${index}` }, policy, now)));
    assert.equal(publicReads.filter(Boolean).length, 5, 'public reads share one company pool');
    assert.equal((await service.allowance(owner.id, now)).regular.committedMicros, 8_000_000);
    assert.equal((await service.allowance(other.id, now)).regular.committedMicros, 0, 'viewers do not pay for shared reads');
    console.log('Integration PostgreSQL concurrency: $8 cap, duplicate dispatch, uncertain holds, account/identity switching and shared reserve passed.');
  } finally { await db.$disconnect(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
