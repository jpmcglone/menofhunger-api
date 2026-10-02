CREATE TABLE "CallBudgetMonth" (
  "month" TEXT PRIMARY KEY,
  "reservedBytes" BIGINT NOT NULL DEFAULT 0 CHECK ("reservedBytes" >= 0)
);
CREATE TABLE "CallBudgetLease" (
  "callId" TEXT PRIMARY KEY,
  "capacity" INTEGER NOT NULL CHECK ("capacity" IN (2, 4)),
  "expiresAt" TIMESTAMPTZ NOT NULL
);
CREATE INDEX "CallBudgetLease_expiresAt_idx" ON "CallBudgetLease" ("expiresAt");
