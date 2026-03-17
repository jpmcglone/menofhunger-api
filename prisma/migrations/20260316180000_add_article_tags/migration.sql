-- CreateTable: ArticleTag
-- Stores curator-defined tags on articles (e.g. "discipline", "stoicism", "business").
-- tag      = normalized slug (lowercase, alphanumeric + hyphens) — uniqueness key
-- label    = display form as the author typed it (cased, e.g. "Stoicism")
-- Composite unique on (articleId, tag) — one tag per slug per article.
CREATE TABLE "ArticleTag" (
    "id"        TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "tag"       TEXT NOT NULL,   -- normalized: lowercase slug
    "label"     TEXT NOT NULL,   -- display label (author-supplied casing)
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleTag_pkey" PRIMARY KEY ("id")
);

-- Unique: one instance of each tag per article
CREATE UNIQUE INDEX "ArticleTag_articleId_tag_key" ON "ArticleTag"("articleId", "tag");

-- Fast lookup by article
CREATE INDEX "ArticleTag_articleId_idx" ON "ArticleTag"("articleId");

-- Tag autocomplete + global tag-based listing
CREATE INDEX "ArticleTag_tag_idx" ON "ArticleTag"("tag");

-- Foreign key
ALTER TABLE "ArticleTag" ADD CONSTRAINT "ArticleTag_articleId_fkey"
    FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;
