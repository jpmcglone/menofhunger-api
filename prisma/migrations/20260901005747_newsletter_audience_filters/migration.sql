-- AlterTable
ALTER TABLE "Newsletter" ADD COLUMN "audienceFilters" JSONB NOT NULL DEFAULT '[]';

UPDATE "Newsletter"
SET "audienceFilters" = '[{"type":"tier","min":"verified"}]'::jsonb
WHERE "verifiedMembersOnly" = true;

ALTER TABLE "Newsletter" DROP COLUMN "verifiedMembersOnly";
