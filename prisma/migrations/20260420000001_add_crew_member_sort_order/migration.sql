-- AlterTable
ALTER TABLE "CrewMember" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "CrewMember_crewId_sortOrder_createdAt_idx" ON "CrewMember"("crewId", "sortOrder", "createdAt");
