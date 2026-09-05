/** Run only against a disposable PostgreSQL database via REGRESSION_DATABASE_URL. */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { CoinsService } from '../src/modules/coins/coins.service';
import { MessagesService } from '../src/modules/messages/messages.service';

const databaseUrl = process.env.REGRESSION_DATABASE_URL;
const databaseTests = databaseUrl ? describe : describe.skip;

databaseTests('coin concurrency and chat deletion (PostgreSQL)', () => {
  const schema = `regression_${randomUUID().replace(/-/g, '')}`;
  let root: PrismaClient;
  let db: PrismaClient;
  let coins: CoinsService;
  const emitMeUpdated = jest.fn(async () => undefined);

  beforeAll(async () => {
    root = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set('schema', schema);
    url.searchParams.set('connection_limit', '16');
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    // Minimal tables exercise the real service queries without loading application data.
    for (const sql of [
      `CREATE TYPE "${schema}"."CoinTransferKind" AS ENUM ('transfer', 'admin_adjust', 'verification_gift')`,
      `CREATE TABLE "User" (id text PRIMARY KEY, coins integer NOT NULL DEFAULT 0)`,
      `CREATE TABLE "CoinTransfer" (id text PRIMARY KEY, "createdAt" timestamp NOT NULL DEFAULT now(), "senderId" text NOT NULL REFERENCES "User"(id), "recipientId" text NOT NULL REFERENCES "User"(id), kind "${schema}"."CoinTransferKind" NOT NULL, amount integer NOT NULL CHECK (amount < 100), note text)`,
      `CREATE INDEX ON "CoinTransfer" ("recipientId", "createdAt" DESC)`,
      `CREATE TABLE "Message" (id text PRIMARY KEY, "conversationId" text NOT NULL, body text NOT NULL, "createdAt" timestamp NOT NULL, "deletedForAll" boolean NOT NULL DEFAULT false)`,
      `CREATE TABLE "MessageParticipant" ("conversationId" text NOT NULL, "userId" text NOT NULL, status text NOT NULL, PRIMARY KEY ("conversationId", "userId"))`,
      `CREATE TABLE "MessageDeletion" ("messageId" text NOT NULL, "userId" text NOT NULL, PRIMARY KEY ("messageId", "userId"))`,
    ]) await db.$executeRawUnsafe(sql);
    coins = new CoinsService(db as any, { r2: () => null } as any, { dispatch: jest.fn() } as any, { emitMeUpdated } as any);
  }, 30000);

  afterAll(async () => {
    await db?.$disconnect();
    if (root) {
      await root.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await root.$disconnect();
    }
  });

  beforeEach(async () => {
    emitMeUpdated.mockClear();
    await db.$executeRaw`TRUNCATE "CoinTransfer", "User", "Message", "MessageParticipant", "MessageDeletion"`;
    await db.$executeRaw`INSERT INTO "User" (id, coins) VALUES ('admin', 0), ('recipient', 10)`;
  });

  it('allows only one concurrent 8-coin deduction from a balance of 10', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => coins.adminAdjustCoins({ adminUserId: 'admin', targetUserId: 'recipient', delta: -8 })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.user.findUnique({ where: { id: 'recipient' }, select: { coins: true } })).toEqual({ coins: 2 });
    expect(await db.coinTransfer.count()).toBe(1);
  });

  it('awards and emits exactly one gift across concurrent calls and retries', async () => {
    await Promise.all(Array.from({ length: 8 }, () => coins.giftVerificationCoins('recipient')));
    await coins.giftVerificationCoins('recipient');
    expect(await db.user.findUnique({ where: { id: 'recipient' }, select: { coins: true } })).toEqual({ coins: 15 });
    expect(await db.coinTransfer.count()).toBe(1);
    expect(emitMeUpdated).toHaveBeenCalledTimes(1);
  });

  it('rolls back the gift balance if the ledger write fails', async () => {
    await expect(coins.giftVerificationCoins('recipient', 100)).rejects.toThrow();
    expect(await db.user.findUnique({ where: { id: 'recipient' }, select: { coins: true } })).toEqual({ coins: 10 });
    expect(await db.coinTransfer.count()).toBe(0);
    expect(emitMeUpdated).not.toHaveBeenCalled();
  });

  it('does not award another gift when a historical gift already exists', async () => {
    await db.$executeRaw`INSERT INTO "CoinTransfer" (id, "senderId", "recipientId", kind, amount) VALUES ('old', 'recipient', 'recipient', 'verification_gift', 5)`;
    await coins.giftVerificationCoins('recipient');
    expect(await db.user.findUnique({ where: { id: 'recipient' }, select: { coins: true } })).toEqual({ coins: 10 });
    expect(await db.coinTransfer.count()).toBe(1);
    expect(emitMeUpdated).not.toHaveBeenCalled();
  });

  it('finds the next visible search hit, excluding only the viewer’s personal deletions', async () => {
    await db.$executeRaw`INSERT INTO "MessageParticipant" VALUES ('conversation', 'viewer', 'accepted'), ('conversation', 'other', 'accepted')`;
    await db.$executeRaw`INSERT INTO "Message" (id, "conversationId", body, "createdAt", "deletedForAll") VALUES
      ('global', 'conversation', 'needle global', '2026-01-04', true),
      ('hidden', 'conversation', 'needle hidden', '2026-01-03', false),
      ('visible', 'conversation', 'needle visible', '2026-01-02', false)`;
    await db.$executeRaw`INSERT INTO "MessageDeletion" VALUES ('hidden', 'viewer'), ('visible', 'other')`;
    const now = new Date();
    const conversation = { id: 'conversation', type: 'direct', createdAt: now, updatedAt: now, participants: [{ userId: 'viewer', status: 'accepted', user: { id: 'viewer' } }] };
    const search = {
      prisma: { $queryRaw: db.$queryRaw.bind(db), messageConversation: { findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([conversation]) } },
      _getBlockedUserIds: async () => new Set(),
      getUnreadCountByConversationId: async () => new Map(),
      appConfig: { r2: () => null },
    };
    const result = await MessagesService.prototype.searchConversations.call(search as any, { userId: 'viewer', query: 'needle', limit: 1 });
    expect(result.conversations[0]?.matchedMessage).toMatchObject({ id: 'visible', body: 'needle visible' });
  });
});
