-- Full-text GIN index over cached link-preview text (title, description, site name, X post and
-- quoted-post text/author). Powers the preview branch of post search (`link_hits` in
-- src/modules/search/search.shared.ts). Expression index, like the Post/Article FTS indexes, so
-- Prisma sees no schema drift. The expression MUST match LINK_PREVIEW_TSV_SQL exactly.
-- Single statement: CONCURRENTLY cannot run inside a transaction block.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "LinkMetadata_preview_fts_idx"
ON "LinkMetadata"
USING GIN (
  to_tsvector(
    'english',
    COALESCE("title", '') || ' ' || COALESCE("description", '') || ' ' || COALESCE("siteName", '') || ' ' ||
    COALESCE("socialPost"->>'text', '') || ' ' || COALESCE("socialPost"#>>'{author,name}', '') || ' ' ||
    COALESCE("socialPost"#>>'{author,handle}', '') || ' ' || COALESCE("socialPost"#>>'{quote,text}', '') || ' ' ||
    COALESCE("socialPost"#>>'{quote,author,name}', '')
  )
);
