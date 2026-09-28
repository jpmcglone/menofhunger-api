ALTER TABLE "User" ADD COLUMN "activationCelebratedAt" TIMESTAMP(3);

-- Existing completed accounts must not replay completion on a new platform.
-- Keep these participation predicates aligned with ActivationService.get.
WITH participation AS (
  SELECT p."userId", p."id", p."parentId", p."createdAt"
  FROM "Post" p JOIN "User" u ON u."id" = p."userId"
  WHERE u."verifiedStatus" <> 'none'
    AND p."deletedAt" IS NULL AND NOT p."isDraft" AND p."scheduledAt" IS NULL
    AND p."visibility" <> 'onlyMe' AND p."kind" IN ('regular', 'checkin')
    AND (u."verifiedAt" IS NULL OR p."createdAt" >= u."verifiedAt")
), first_activity AS (
  SELECT "userId", MIN("createdAt") AS "firstAt" FROM participation GROUP BY "userId"
)
UPDATE "User" u SET "activationCelebratedAt" = CURRENT_TIMESTAMP
FROM first_activity f
WHERE u."id" = f."userId"
  AND EXISTS (
    SELECT 1 FROM participation p
    JOIN "Post" parent ON parent."id" = p."parentId"
    JOIN "User" author ON author."id" = parent."userId"
    WHERE p."userId" = u."id" AND parent."userId" <> u."id"
      AND parent."deletedAt" IS NULL AND NOT author."isBot"
  )
  AND EXISTS (
    SELECT 1 FROM participation p WHERE p."userId" = u."id"
      AND p."createdAt" >= date_trunc('day', f."firstAt") + INTERVAL '1 day'
  );
