-- Add premium_started and premium_ended to the NotificationKind enum.
-- PostgreSQL requires a separate ALTER TYPE statement per new value.
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'premium_started';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'premium_ended';
