-- CreateTable
CREATE TABLE "UserOrgMembership" (
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserOrgMembership_pkey" PRIMARY KEY ("userId","orgId")
);

-- CreateIndex
CREATE INDEX "UserOrgMembership_orgId_idx" ON "UserOrgMembership"("orgId");

-- CreateIndex
CREATE INDEX "UserOrgMembership_userId_createdAt_idx" ON "UserOrgMembership"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "UserOrgMembership" ADD CONSTRAINT "UserOrgMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserOrgMembership" ADD CONSTRAINT "UserOrgMembership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
