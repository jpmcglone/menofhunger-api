-- Every verified person belongs to the official Men of Hunger group (slug: men-of-hunger).
-- New verifications join in UserVerificationService. No-op when the group does not exist.
INSERT INTO "CommunityGroupMember" ("groupId", "userId", "role", "status", "notificationPreference", "createdAt", "updatedAt")
SELECT g.id, u.id, 'member', 'active', 'repliesAndMentions', NOW(), NOW()
FROM "CommunityGroup" g
JOIN "User" u ON u."verifiedStatus" <> 'none' AND u."bannedAt" IS NULL AND u."isBot" = false AND u."isOrganization" = false
WHERE g.slug = 'men-of-hunger' AND g."deletedAt" IS NULL
ON CONFLICT ("groupId", "userId") DO UPDATE SET "status" = 'active', "updatedAt" = NOW();

UPDATE "CommunityGroup" g
SET "memberCount" = (SELECT COUNT(*) FROM "CommunityGroupMember" m WHERE m."groupId" = g.id AND m."status" = 'active')
WHERE g.slug = 'men-of-hunger' AND g."deletedAt" IS NULL;
