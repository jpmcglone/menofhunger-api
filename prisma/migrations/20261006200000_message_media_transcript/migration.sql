ALTER TABLE "MessageMedia"
  ADD COLUMN "transcriptStatus" TEXT,
  ADD COLUMN "transcript" TEXT,
  ADD COLUMN "transcribedAt" TIMESTAMP(3);
