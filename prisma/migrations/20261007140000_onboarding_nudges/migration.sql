-- AlterTable
ALTER TABLE "User" ADD COLUMN     "onboardingNudge1SentAt" TIMESTAMP(3),
ADD COLUMN     "onboardingNudge3SentAt" TIMESTAMP(3),
ADD COLUMN     "onboardingNudge7SentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "NotificationPreferences" ADD COLUMN     "emailOnboarding" BOOLEAN NOT NULL DEFAULT true;
