-- CreateEnum
CREATE TYPE "FitnessProvider" AS ENUM ('strava', 'apple_health');

-- CreateEnum
CREATE TYPE "FitnessActivityType" AS ENUM ('run', 'ride', 'walk', 'swim', 'workout', 'hike', 'yoga', 'other');

-- CreateEnum
CREATE TYPE "FitnessUnits" AS ENUM ('us', 'metric');

-- CreateEnum
CREATE TYPE "FitnessShareType" AS ENUM ('activity', 'weight', 'progress');

-- AlterEnum
ALTER TYPE "PostKind" ADD VALUE 'fitnessShare';

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "fitnessShareId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "fitnessUnits" "FitnessUnits" NOT NULL DEFAULT 'us';

-- CreateTable
CREATE TABLE "FitnessConnection" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "FitnessProvider" NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "providerUserId" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastManualSyncAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastError" TEXT,

    CONSTRAINT "FitnessConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FitnessActivity" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "provider" "FitnessProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "activityType" "FitnessActivityType" NOT NULL DEFAULT 'other',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER NOT NULL,
    "distanceM" DOUBLE PRECISION,
    "effortScore" DOUBLE PRECISION,
    "stepsCount" INTEGER,
    "dedupeKey" TEXT,
    "dedupedFromId" TEXT,
    "dedupedFromProvider" "FitnessProvider",

    CONSTRAINT "FitnessActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FitnessDailySummary" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "stepsCount" INTEGER,
    "workoutMinutes" INTEGER,
    "distanceM" DOUBLE PRECISION,
    "effortScore" DOUBLE PRECISION,
    "caloriesIn" INTEGER,
    "caloriesOut" INTEGER,
    "sleepMinutes" INTEGER,
    "hrvMs" DOUBLE PRECISION,

    CONSTRAINT "FitnessDailySummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FitnessBodyMetric" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "weightKg" DOUBLE PRECISION NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "externalId" TEXT,

    CONSTRAINT "FitnessBodyMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FitnessGoal" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'weight',
    "startKg" DOUBLE PRECISION,
    "targetKg" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "FitnessGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FitnessShare" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "shareType" "FitnessShareType" NOT NULL,
    "activityId" TEXT,
    "bodyMetricId" TEXT,
    "goalId" TEXT,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "FitnessShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FitnessConnection_userId_idx" ON "FitnessConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FitnessConnection_userId_provider_key" ON "FitnessConnection"("userId", "provider");

-- CreateIndex
CREATE INDEX "FitnessActivity_userId_startedAt_idx" ON "FitnessActivity"("userId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "FitnessActivity_userId_provider_idx" ON "FitnessActivity"("userId", "provider");

-- CreateIndex
CREATE INDEX "FitnessActivity_dedupeKey_idx" ON "FitnessActivity"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "FitnessActivity_userId_provider_externalId_key" ON "FitnessActivity"("userId", "provider", "externalId");

-- CreateIndex
CREATE INDEX "FitnessDailySummary_userId_dayKey_idx" ON "FitnessDailySummary"("userId", "dayKey" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "FitnessDailySummary_userId_dayKey_key" ON "FitnessDailySummary"("userId", "dayKey");

-- CreateIndex
CREATE INDEX "FitnessBodyMetric_userId_measuredAt_idx" ON "FitnessBodyMetric"("userId", "measuredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "FitnessBodyMetric_userId_source_externalId_key" ON "FitnessBodyMetric"("userId", "source", "externalId");

-- CreateIndex
CREATE INDEX "FitnessGoal_userId_idx" ON "FitnessGoal"("userId");

-- CreateIndex
CREATE INDEX "FitnessShare_userId_idx" ON "FitnessShare"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Post_fitnessShareId_key" ON "Post"("fitnessShareId");

-- CreateIndex
CREATE INDEX "Post_fitnessShareId_idx" ON "Post"("fitnessShareId");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_fitnessShareId_fkey" FOREIGN KEY ("fitnessShareId") REFERENCES "FitnessShare"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitnessConnection" ADD CONSTRAINT "FitnessConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitnessActivity" ADD CONSTRAINT "FitnessActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitnessDailySummary" ADD CONSTRAINT "FitnessDailySummary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitnessBodyMetric" ADD CONSTRAINT "FitnessBodyMetric_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitnessGoal" ADD CONSTRAINT "FitnessGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitnessShare" ADD CONSTRAINT "FitnessShare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
