-- Full-text search (FTS) GIN index for Article search.
--
-- Without this index, searchArticles() computes to_tsvector() at query time,
-- which requires a sequential scan and degrades as the article count grows.
--
-- Covers title + excerpt + tags (joined as text). Body is stored as Tiptap JSON
-- and is not directly indexed here; the title/excerpt/tag coverage handles the
-- common search patterns already used in searchArticles().
--
-- The conditional partial index (WHERE isDraft = false AND deletedAt IS NULL)
-- keeps the index small — only published articles are searched.

CREATE INDEX CONCURRENTLY "Article_title_excerpt_fts_idx"
ON "Article"
USING GIN (
  to_tsvector(
    'english',
    COALESCE("title", '') || ' ' || COALESCE("excerpt", '')
  )
)
WHERE "isDraft" = false AND "deletedAt" IS NULL AND "publishedAt" IS NOT NULL;
