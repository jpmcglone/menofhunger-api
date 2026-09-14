-- Group posts already require group access. Align legacy public rows with that
-- verified audience, including replies/reposts. Preserve private drafts and any
-- historically stricter audience instead of broadening access.
UPDATE "Post"
SET "visibility" = 'verifiedOnly'
WHERE "communityGroupId" IS NOT NULL
  AND "visibility" = 'public'
  AND "isDraft" = false;

-- Scheduled holding rows remain onlyMe drafts; only their publishing audience changes.
UPDATE "Post"
SET "scheduledVisibility" = 'verifiedOnly'
WHERE "scheduledCommunityGroupId" IS NOT NULL
  AND "scheduledVisibility" = 'public';
