-- CreateTable
CREATE TABLE "LinkMetadata" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "imageUrl" TEXT,
    "siteName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkMetadata_url_key" ON "LinkMetadata"("url");

-- CreateIndex
CREATE INDEX "LinkMetadata_url_idx" ON "LinkMetadata"("url");
