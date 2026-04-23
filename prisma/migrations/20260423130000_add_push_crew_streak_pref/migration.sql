-- Add the per-user push preference for the strict crew-streak system event.
-- Default true: this is the highest-signal push in the product (advance + break-the-morning-after).
-- The user can disable via settings if they don't want it. There is no "remember to check in" reminder
-- push — peer status + the strict rule are the only nudges, by design.
ALTER TABLE "NotificationPreferences"
ADD COLUMN "pushCrewStreak" BOOLEAN NOT NULL DEFAULT true;
