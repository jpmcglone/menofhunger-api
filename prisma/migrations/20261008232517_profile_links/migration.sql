-- AlterTable
ALTER TABLE "User" ADD COLUMN     "showXFollowerCount" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ProfileLink" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "legacyField" TEXT,
    "grandfathered" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProfileLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProfileLink_userId_position_idx" ON "ProfileLink"("userId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileLink_userId_legacyField_key" ON "ProfileLink"("userId", "legacyField");

-- AddForeignKey
ALTER TABLE "ProfileLink" ADD CONSTRAINT "ProfileLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data migration: mirror legacy User link columns into ProfileLink (grandfathered).
INSERT INTO "ProfileLink" ("id", "updatedAt", "userId", "url", "title", "position", "legacyField", "grandfathered")
SELECT
  md5(l."userId" || ':' || l."field"),
  CURRENT_TIMESTAMP,
  l."userId",
  l."url",
  CASE
    WHEN l."field" = 'website' THEN
      regexp_replace(regexp_replace(regexp_replace(l."url", '^[a-zA-Z][a-zA-Z0-9+.-]*://', ''), '^www\.', '', 'i'), '[/?#].*$', '')
    WHEN l."field" = 'youtube' THEN 'YouTube'
    WHEN l."field" = 'rumble' THEN 'Rumble'
    ELSE 'LinkedIn'
  END,
  (row_number() OVER (PARTITION BY l."userId" ORDER BY l."pos") - 1)::int,
  l."field",
  true
FROM (
  SELECT
    u."id" AS "userId",
    v."field",
    v."pos",
    regexp_replace(btrim(v."raw"), '^http://', 'https://', 'i') AS "url"
  FROM "User" u
  CROSS JOIN LATERAL (
    VALUES
      ('website', u."website", 0),
      ('youtube', u."youtubeUrl", 1),
      ('rumble', u."rumbleUrl", 2),
      ('linkedin', u."linkedinUrl", 3)
  ) AS v("field", "raw", "pos")
  WHERE v."raw" IS NOT NULL AND btrim(v."raw") <> ''
) l
ON CONFLICT DO NOTHING;

-- Keep the deprecated User mirror columns consistent with the https-rewritten links.
UPDATE "User" SET "website" = regexp_replace(btrim("website"), '^http://', 'https://', 'i') WHERE "website" IS NOT NULL AND "website" ~* '^\s*http://';
UPDATE "User" SET "youtubeUrl" = regexp_replace(btrim("youtubeUrl"), '^http://', 'https://', 'i') WHERE "youtubeUrl" IS NOT NULL AND "youtubeUrl" ~* '^\s*http://';
UPDATE "User" SET "rumbleUrl" = regexp_replace(btrim("rumbleUrl"), '^http://', 'https://', 'i') WHERE "rumbleUrl" IS NOT NULL AND "rumbleUrl" ~* '^\s*http://';
UPDATE "User" SET "linkedinUrl" = regexp_replace(btrim("linkedinUrl"), '^http://', 'https://', 'i') WHERE "linkedinUrl" IS NOT NULL AND "linkedinUrl" ~* '^\s*http://';
