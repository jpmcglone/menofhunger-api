-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('person', 'page');

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "operatedByUserId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "accountKind" "AccountKind" NOT NULL DEFAULT 'person',
ALTER COLUMN "phone" DROP NOT NULL;

-- CreateTable
CREATE TABLE "UserPageOperator" (
    "operatorUserId" TEXT NOT NULL,
    "pageUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPageOperator_pkey" PRIMARY KEY ("operatorUserId","pageUserId")
);

-- CreateTable
CREATE TABLE "ParkedPhone" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "phone" TEXT NOT NULL,
    "formerUserId" TEXT NOT NULL,
    "parkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releaseAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "ParkedPhone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserPageOperator_pageUserId_idx" ON "UserPageOperator"("pageUserId");

-- CreateIndex
CREATE INDEX "UserPageOperator_operatorUserId_createdAt_idx" ON "UserPageOperator"("operatorUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ParkedPhone_phone_key" ON "ParkedPhone"("phone");

-- CreateIndex
CREATE INDEX "ParkedPhone_releaseAt_idx" ON "ParkedPhone"("releaseAt");

-- CreateIndex
CREATE INDEX "ParkedPhone_formerUserId_idx" ON "ParkedPhone"("formerUserId");

-- CreateIndex
CREATE INDEX "Session_operatedByUserId_idx" ON "Session"("operatedByUserId");

-- CreateIndex
CREATE INDEX "User_accountKind_idx" ON "User"("accountKind");

-- AddForeignKey
ALTER TABLE "UserPageOperator" ADD CONSTRAINT "UserPageOperator_operatorUserId_fkey" FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPageOperator" ADD CONSTRAINT "UserPageOperator_pageUserId_fkey" FOREIGN KEY ("pageUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParkedPhone" ADD CONSTRAINT "ParkedPhone_formerUserId_fkey" FOREIGN KEY ("formerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_operatedByUserId_fkey" FOREIGN KEY ("operatedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
