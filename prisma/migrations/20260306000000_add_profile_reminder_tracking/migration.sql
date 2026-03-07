-- Add one-time profile-completion reminder send-tracking columns to User
ALTER TABLE "User" ADD COLUMN "profileReminder24hSentAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "profileReminder7dSentAt"  TIMESTAMP(3);
