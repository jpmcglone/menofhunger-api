CREATE TABLE "IntegrationUsageReservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "provider" TEXT NOT NULL,
    "externalAccountId" TEXT,
    "action" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "month" TIMESTAMP(3) NOT NULL,
    "priceVersion" TEXT NOT NULL,
    "reservedMicros" INTEGER NOT NULL,
    "chargedMicros" INTEGER,
    "publicationCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IntegrationUsageReservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IntegrationUsageReservation_cost_check" CHECK (
      "reservedMicros" >= 0 AND ("chargedMicros" IS NULL OR "chargedMicros" >= 0)
      AND "publicationCount" >= 0
    ),
    CONSTRAINT "IntegrationUsageReservation_status_check" CHECK (
      "status" IN ('reserved', 'settled', 'released', 'uncertain')
    ),
    CONSTRAINT "IntegrationUsageReservation_bucket_check" CHECK (
      "bucket" IN ('regular', 'expensive', 'reserve', 'acquisition')
    )
);
CREATE INDEX "IntegrationUsageReservation_userId_month_bucket_status_idx"
 ON "IntegrationUsageReservation"("userId", "month", "bucket", "status");
CREATE INDEX "IntegrationUsageReservation_provider_externalAccountId_month_idx"
 ON "IntegrationUsageReservation"("provider", "externalAccountId", "month", "status");
CREATE INDEX "IntegrationUsageReservation_month_bucket_status_idx"
 ON "IntegrationUsageReservation"("month", "bucket", "status");

-- Keep existing operation IDs, held uncertain requests, external identities and
-- original UTC months. Legacy prices are labeled estimates, not invoices.
INSERT INTO "IntegrationUsageReservation" (
 "id", "userId", "provider", "externalAccountId", "action", "bucket", "month",
 "priceVersion", "reservedMicros", "publicationCount", "status", "createdAt"
)
SELECT r."id", r."userId", 'x', r."externalAccountId", 'create',
 CASE WHEN r."hasLink" THEN 'expensive'
      WHEN COALESCE(u."premium", false) OR COALESCE(u."premiumPlus", false) THEN 'regular'
      ELSE 'acquisition' END,
 r."month", 'legacy-x-estimate', CASE WHEN r."hasLink" THEN 200000 ELSE 15000 END,
 1, CASE WHEN r."status" = 'sent' THEN 'settled' ELSE r."status" END, r."createdAt"
FROM "XUsageReservation" r LEFT JOIN "User" u ON u."id" = r."userId";

-- Old dollar-budget deliveries predate XUsageReservation. Import only rows
-- without an equivalent operation so a migration never resets or doubles use.
INSERT INTO "IntegrationUsageReservation" (
 "id", "userId", "provider", "externalAccountId", "action", "bucket", "month",
 "priceVersion", "reservedMicros", "publicationCount", "status", "createdAt"
)
SELECT 'x:' || c."kind"::text || ':' || c."localId", c."userId", 'x', x."xUserId", 'create',
 CASE WHEN c."costMicros" >= 200000 THEN 'expensive' ELSE 'regular' END,
 date_trunc('month', c."createdAt"), 'legacy-x-recorded', c."costMicros", 1,
 CASE WHEN c."remoteId" IS NOT NULL THEN 'settled'
      WHEN c."refundedAt" IS NOT NULL THEN 'released' ELSE 'uncertain' END, c."createdAt"
FROM "XCrosspost" c LEFT JOIN "XConnection" x ON x."userId" = c."userId"
ON CONFLICT ("id") DO NOTHING;
