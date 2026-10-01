CREATE TABLE "IntegrationPublicSnapshot" (
  "key" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "identity" TEXT NOT NULL,
  "handle" TEXT, "payload" JSONB NOT NULL, "fetchedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "IntegrationPublicSnapshot_kind_handle_expiresAt_idx" ON "IntegrationPublicSnapshot"("kind", "handle", "expiresAt");
CREATE INDEX "IntegrationPublicSnapshot_expiresAt_idx" ON "IntegrationPublicSnapshot"("expiresAt");
CREATE INDEX "IntegrationUsageReservation_provider_action_status_idx" ON "IntegrationUsageReservation"("provider", "action", "status");
CREATE INDEX "IntegrationUsageReservation_status_createdAt_idx" ON "IntegrationUsageReservation"("status", "createdAt");
CREATE TABLE "IntegrationSpendControl" (
 "id" TEXT PRIMARY KEY DEFAULT 'global', "revision" INTEGER NOT NULL DEFAULT 0,
 "paused" BOOLEAN NOT NULL DEFAULT false, "companyMonthlyMicros" INTEGER,
 "companyDailyMicros" INTEGER, "xMonthlyMicros" INTEGER, "reserveMonthlyMicros" INTEGER,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "IntegrationControlAudit" (
 "id" TEXT PRIMARY KEY, "adminUserId" TEXT NOT NULL, "revision" INTEGER NOT NULL,
 "before" JSONB NOT NULL, "after" JSONB NOT NULL, "reason" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "IntegrationControlAudit_createdAt_idx" ON "IntegrationControlAudit"("createdAt");
CREATE TABLE "IntegrationOperationalAlert" (
 "key" TEXT PRIMARY KEY, "severity" TEXT NOT NULL, "message" TEXT NOT NULL,
 "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolvedAt" TIMESTAMP(3)
);
CREATE INDEX "IntegrationOperationalAlert_resolvedAt_openedAt_idx" ON "IntegrationOperationalAlert"("resolvedAt", "openedAt");

ALTER TABLE "XCrosspost" ADD COLUMN "deliveryPlan" JSONB, ADD COLUMN "remoteIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
