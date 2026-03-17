-- Unified taxonomy system (DB-first)
CREATE TYPE "TaxonomyTermKind" AS ENUM ('topic', 'subtopic', 'tag');
CREATE TYPE "TaxonomyTermStatus" AS ENUM ('active', 'hidden');
CREATE TYPE "TaxonomyAliasSource" AS ENUM ('topic_config', 'article_tag', 'hashtag', 'manual');
CREATE TYPE "TaxonomyEdgeRelation" AS ENUM ('parent', 'related', 'synonym');

CREATE TABLE "TaxonomyTerm" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "TaxonomyTermKind" NOT NULL,
    "status" "TaxonomyTermStatus" NOT NULL DEFAULT 'active',
    CONSTRAINT "TaxonomyTerm_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaxonomyAlias" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "alias" TEXT NOT NULL,
    "source" "TaxonomyAliasSource" NOT NULL,
    "termId" TEXT NOT NULL,
    CONSTRAINT "TaxonomyAlias_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaxonomyEdge" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "relation" "TaxonomyEdgeRelation" NOT NULL,
    "fromTermId" TEXT NOT NULL,
    "toTermId" TEXT NOT NULL,
    CONSTRAINT "TaxonomyEdge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserTaxonomyPreference" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    CONSTRAINT "UserTaxonomyPreference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaxonomyTermMetric" (
    "termId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "articleCount" INTEGER NOT NULL DEFAULT 0,
    "postCount" INTEGER NOT NULL DEFAULT 0,
    "hashtagCount" INTEGER NOT NULL DEFAULT 0,
    "recentVelocity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "engagementScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    CONSTRAINT "TaxonomyTermMetric_pkey" PRIMARY KEY ("termId")
);

CREATE UNIQUE INDEX "TaxonomyTerm_slug_key" ON "TaxonomyTerm"("slug");
CREATE INDEX "TaxonomyTerm_kind_status_idx" ON "TaxonomyTerm"("kind", "status");

CREATE UNIQUE INDEX "TaxonomyAlias_alias_key" ON "TaxonomyAlias"("alias");
CREATE INDEX "TaxonomyAlias_termId_source_idx" ON "TaxonomyAlias"("termId", "source");

CREATE UNIQUE INDEX "TaxonomyEdge_fromTermId_toTermId_relation_key" ON "TaxonomyEdge"("fromTermId", "toTermId", "relation");
CREATE INDEX "TaxonomyEdge_fromTermId_relation_idx" ON "TaxonomyEdge"("fromTermId", "relation");
CREATE INDEX "TaxonomyEdge_toTermId_relation_idx" ON "TaxonomyEdge"("toTermId", "relation");

CREATE UNIQUE INDEX "UserTaxonomyPreference_userId_termId_key" ON "UserTaxonomyPreference"("userId", "termId");
CREATE INDEX "UserTaxonomyPreference_userId_idx" ON "UserTaxonomyPreference"("userId");
CREATE INDEX "UserTaxonomyPreference_termId_idx" ON "UserTaxonomyPreference"("termId");

CREATE INDEX "TaxonomyTermMetric_engagementScore_idx" ON "TaxonomyTermMetric"("engagementScore" DESC);
CREATE INDEX "TaxonomyTermMetric_recentVelocity_idx" ON "TaxonomyTermMetric"("recentVelocity" DESC);

ALTER TABLE "TaxonomyAlias" ADD CONSTRAINT "TaxonomyAlias_termId_fkey"
    FOREIGN KEY ("termId") REFERENCES "TaxonomyTerm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaxonomyEdge" ADD CONSTRAINT "TaxonomyEdge_fromTermId_fkey"
    FOREIGN KEY ("fromTermId") REFERENCES "TaxonomyTerm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaxonomyEdge" ADD CONSTRAINT "TaxonomyEdge_toTermId_fkey"
    FOREIGN KEY ("toTermId") REFERENCES "TaxonomyTerm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserTaxonomyPreference" ADD CONSTRAINT "UserTaxonomyPreference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserTaxonomyPreference" ADD CONSTRAINT "UserTaxonomyPreference_termId_fkey"
    FOREIGN KEY ("termId") REFERENCES "TaxonomyTerm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaxonomyTermMetric" ADD CONSTRAINT "TaxonomyTermMetric_termId_fkey"
    FOREIGN KEY ("termId") REFERENCES "TaxonomyTerm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
