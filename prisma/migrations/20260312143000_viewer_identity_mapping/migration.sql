-- CreateTable
CREATE TABLE "ViewerIdentity" (
    "anonId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ViewerIdentity_pkey" PRIMARY KEY ("anonId")
);

-- CreateIndex
CREATE INDEX "ViewerIdentity_userId_idx" ON "ViewerIdentity"("userId");

-- AddForeignKey
ALTER TABLE "ViewerIdentity" ADD CONSTRAINT "ViewerIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
