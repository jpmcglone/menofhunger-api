-- Default channels have fixed identities: announcements and random get their icons, general keeps "#".
UPDATE "GroupChannel" SET "icon" = '📢', "displayName" = NULL WHERE "defaultPurpose" = 'announcements';
UPDATE "GroupChannel" SET "icon" = '🎲', "displayName" = NULL WHERE "defaultPurpose" = 'random';
UPDATE "GroupChannel" SET "icon" = NULL, "displayName" = NULL WHERE "defaultPurpose" = 'general';
