import { PrismaClient } from '@prisma/client';
import { eraseAccountRecords, DELETED_ACCOUNT_ID } from './account-erasure';

// Opt-in only. Never falls back to DATABASE_URL or a developer/production database.
const fixtureUrl = process.env.MOH_ERASURE_FIXTURE_DATABASE_URL;
const enabled = fixtureUrl && new URL(fixtureUrl).hostname === '127.0.0.1' && new URL(fixtureUrl).pathname === '/moh_erasure_fixture';
(enabled ? describe : describe.skip)('account erasure on an isolated synthetic database', () => {
  const db = new PrismaClient({ datasources: { db: { url: fixtureUrl ?? 'postgresql://invalid/never-connect' } } });
  afterAll(async () => db.$disconnect());
  it('erases private records and own content while preserving other members and shared ownership', async () => {
    const existing = await db.user.findUnique({ where: { id: 'migration_fixture' } });
    expect(existing).toMatchObject({ phone: '+15550000999', appleSandboxOriginalTransactionId: null });
    const owner = await db.user.create({ data: { username: 'erasure_fixture_owner', phone: '+15550000001', email: 'fixture@example.invalid', name: 'Synthetic Owner' } });
    const other = await db.user.create({ data: { username: 'erasure_fixture_other', phone: '+15550000002' } });
    const post = await db.post.create({ data: { userId: owner.id, body: 'synthetic private text', visibility: 'public' } });
    const reply = await db.post.create({ data: { userId: other.id, body: 'Preserve this reply', parentId: post.id, rootId: post.id, visibility: 'public' } });
    const conversation = await db.messageConversation.create({ data: { type: 'direct', createdByUserId: owner.id, directKey: [owner.id, other.id].sort().join(':') } });
    await db.message.create({ data: { senderId: owner.id, conversationId: conversation.id, body: 'erase my message' } });
    const otherMessage = await db.message.create({ data: { senderId: other.id, conversationId: conversation.id, body: 'keep their message' } });
    await db.fitnessConnection.create({ data: { userId: owner.id, provider: 'strava', accessToken: 'synthetic-secret', refreshToken: 'synthetic-refresh' } });
    await db.fitnessActivity.create({ data: { userId: owner.id, provider: 'apple_health', externalId: 'fixture', startedAt: new Date(), durationSec: 120 } });
    await db.fitnessBodyMetric.create({ data: { userId: owner.id, weightKg: 80, measuredAt: new Date() } });
    await db.fitnessDailySummary.create({ data: { userId: owner.id, dayKey: '2026-09-16', stepsCount: 5000 } });
    const group = await db.communityGroup.create({ data: { slug: 'erasure-fixture', name: 'Synthetic group', description: 'Keep shared group', createdByUserId: owner.id, memberCount: 2 } });
    await db.communityGroupMember.createMany({ data: [{ groupId: group.id, userId: owner.id, status: 'active', role: 'owner' }, { groupId: group.id, userId: other.id, status: 'active', role: 'member' }] });
    await db.$transaction(tx => eraseAccountRecords(tx, owner.id), { timeout: 60000 });
    expect(await db.user.findUnique({ where: { id: owner.id } })).toBeNull();
    expect(await db.post.findUnique({ where: { id: post.id } })).toMatchObject({ userId: DELETED_ACCOUNT_ID, body: '', deletedAt: expect.any(Date) });
    expect(await db.post.findUnique({ where: { id: reply.id } })).toMatchObject({ userId: other.id, body: 'Preserve this reply' });
    expect(await db.message.findUnique({ where: { id: otherMessage.id } })).not.toBeNull();
    expect(await db.message.count({ where: { senderId: owner.id } })).toBe(0);
    for (const model of [db.fitnessConnection, db.fitnessActivity, db.fitnessBodyMetric, db.fitnessDailySummary] as any[]) expect(await model.count({ where: { userId: owner.id } })).toBe(0);
    expect(await db.communityGroup.findUnique({ where: { id: group.id } })).toMatchObject({ createdByUserId: other.id, memberCount: 1 });
    expect(await db.communityGroupMember.findUnique({ where: { groupId_userId: { groupId: group.id, userId: other.id } } })).toMatchObject({ role: 'owner' });
  });
});
