-- Add editedAt and deletedForAll fields to Message
ALTER TABLE "Message" ADD COLUMN "editedAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN "deletedForAll" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Message" ADD COLUMN "deletedForAllAt" TIMESTAMP(3);

-- Index for finding edited/deleted messages efficiently
CREATE INDEX "Message_deletedForAll_idx" ON "Message"("deletedForAll");
