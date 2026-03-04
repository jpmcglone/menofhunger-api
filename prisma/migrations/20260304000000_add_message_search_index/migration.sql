-- Enable trigram extension for fast ILIKE substring search on message bodies.
-- This powers the chat message content search without any third-party service.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN index on Message.body using trigrams. Only indexes non-deleted-for-all messages.
-- Makes ILIKE '%query%' fast (O(log n) instead of sequential scan).
CREATE INDEX IF NOT EXISTS "Message_body_trgm_idx"
  ON "Message" USING GIN (body gin_trgm_ops)
  WHERE "deletedForAll" = false;
