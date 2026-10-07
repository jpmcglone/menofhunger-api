-- Additive, nullable columns only: safe to deploy without downtime.
ALTER TABLE "User" ADD COLUMN "signupSource" TEXT,
ADD COLUMN "signupMedium" TEXT,
ADD COLUMN "signupCampaign" TEXT,
ADD COLUMN "signupLandingPath" TEXT,
ADD COLUMN "signupReferrerHost" TEXT;

CREATE INDEX "User_signupSource_idx" ON "User"("signupSource");
CREATE INDEX "User_signupCampaign_idx" ON "User"("signupCampaign");
