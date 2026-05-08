-- Add 'auto' value to the MarvinMode enum and make it the default for new rows.
-- Existing rows keep their current preference (fast / regular / smart).

ALTER TYPE "MarvinMode" ADD VALUE 'auto';
