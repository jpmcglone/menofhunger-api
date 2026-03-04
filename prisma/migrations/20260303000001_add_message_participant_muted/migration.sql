-- Add mutedAt to MessageParticipant for per-thread notification preferences
ALTER TABLE "MessageParticipant" ADD COLUMN "mutedAt" TIMESTAMP(3);
