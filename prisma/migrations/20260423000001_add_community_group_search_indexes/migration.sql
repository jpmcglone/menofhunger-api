-- Indexes that back the new fuzzy + multi-word group search.
-- Notes:
-- - pg_trgm is already enabled by 20260413000003_add_taxonomy_trgm_indexes,
--   but `IF NOT EXISTS` keeps this migration idempotent on fresh databases.
-- - GIN trigram indexes let Postgres serve `ILIKE '%q%'`, the `%` similarity
--   operator, and `similarity()` ranking from an index instead of a seq scan.
-- - The expression GIN FTS index avoids Prisma schema drift from generated
--   tsvector columns (same pattern as Post/User FTS indexes).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "CommunityGroup_name_trgm_idx"
  ON "CommunityGroup" USING GIN ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "CommunityGroup_slug_trgm_idx"
  ON "CommunityGroup" USING GIN ("slug" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "CommunityGroup_description_trgm_idx"
  ON "CommunityGroup" USING GIN ("description" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "CommunityGroup_fts_idx"
  ON "CommunityGroup"
  USING GIN (
    to_tsvector(
      'english',
      COALESCE("name", '') || ' ' ||
      COALESCE("slug", '') || ' ' ||
      COALESCE("description", '') || ' ' ||
      COALESCE("rules", '')
    )
  )
  WHERE "deletedAt" IS NULL;
