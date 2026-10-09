-- CreateTable
CREATE TABLE "PostLink" (
    "postId" TEXT NOT NULL,
    "url" TEXT NOT NULL,

    CONSTRAINT "PostLink_pkey" PRIMARY KEY ("postId","url")
);

-- CreateIndex
CREATE INDEX "PostLink_url_idx" ON "PostLink"("url");

-- AddForeignKey
ALTER TABLE "PostLink" ADD CONSTRAINT "PostLink_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
