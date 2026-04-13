-- Enable pg_trgm extension for LIKE '%q%' substring searches.
-- Needed by taxonomy term label/slug search in TaxonomyService.search().
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram indexes allow Postgres to use an index for `LIKE '%q%'` (contains) patterns.
-- These replace sequential scans on TaxonomyTerm.label, TaxonomyTerm.slug, and TaxonomyAlias.alias.
CREATE INDEX IF NOT EXISTS "TaxonomyTerm_label_trgm_idx"
  ON "TaxonomyTerm" USING GIN ("label" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "TaxonomyTerm_slug_trgm_idx"
  ON "TaxonomyTerm" USING GIN ("slug" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "TaxonomyAlias_alias_trgm_idx"
  ON "TaxonomyAlias" USING GIN ("alias" gin_trgm_ops);
