-- Migration: push_coalesce_per_subject
--
-- Changes PushCoalesce primary key from (userId, kind) to (userId, coalesceKey)
-- so coalescing is scoped per subject/tag rather than per notification kind.
-- Existing rows are transient (max TTL is 15 min) and are safe to drop.

DROP TABLE IF EXISTS "PushCoalesce";

CREATE TABLE "PushCoalesce" (
    "userId"      TEXT NOT NULL,
    "coalesceKey" TEXT NOT NULL,
    "sentAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushCoalesce_pkey" PRIMARY KEY ("userId","coalesceKey")
);

CREATE INDEX "PushCoalesce_userId_coalesceKey_idx" ON "PushCoalesce"("userId", "coalesceKey");

ALTER TABLE "PushCoalesce" ADD CONSTRAINT "PushCoalesce_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
