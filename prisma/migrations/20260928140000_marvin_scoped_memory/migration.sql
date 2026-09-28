-- Store provenance only. Exactly one source; deleting that source removes its memory.
CREATE TABLE "MarvinMemorySource" (
  "id" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "learnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "postId" TEXT,
  "messageId" TEXT,
  CONSTRAINT "MarvinMemorySource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MarvinMemorySource_one_source" CHECK (("postId" IS NOT NULL)::int + ("messageId" IS NOT NULL)::int = 1),
  CONSTRAINT "MarvinMemorySource_scope" CHECK (
    ("postId" IS NOT NULL AND ("scopeKey" = 'public' OR "scopeKey" LIKE 'group:%' OR "scopeKey" LIKE 'thread:%'))
    OR ("messageId" IS NOT NULL AND "scopeKey" LIKE 'conversation:%')
  )
);
CREATE UNIQUE INDEX "MarvinMemorySource_postId_key" ON "MarvinMemorySource"("postId");
CREATE UNIQUE INDEX "MarvinMemorySource_messageId_key" ON "MarvinMemorySource"("messageId");
CREATE INDEX "MarvinMemorySource_scopeKey_learnedAt_idx" ON "MarvinMemorySource"("scopeKey", "learnedAt");
ALTER TABLE "MarvinMemorySource" ADD CONSTRAINT "MarvinMemorySource_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarvinMemorySource" ADD CONSTRAINT "MarvinMemorySource_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
