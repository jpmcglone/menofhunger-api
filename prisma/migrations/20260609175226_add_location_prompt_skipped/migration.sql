-- AddColumn
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "locationPromptSkipped" BOOLEAN NOT NULL DEFAULT false;
