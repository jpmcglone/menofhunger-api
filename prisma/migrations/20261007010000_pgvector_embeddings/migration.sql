CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "PostEmbedding" (
    "postId" TEXT NOT NULL,
    "model" VARCHAR(64) NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "embedding" vector(512) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PostEmbedding_pkey" PRIMARY KEY ("postId")
);

CREATE TABLE "GroupEmbedding" (
    "groupId" TEXT NOT NULL,
    "model" VARCHAR(64) NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "embedding" vector(512) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GroupEmbedding_pkey" PRIMARY KEY ("groupId")
);

CREATE TABLE "UserEmbedding" (
    "userId" TEXT NOT NULL,
    "model" VARCHAR(64) NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "embedding" vector(512) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserEmbedding_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "PostEmbedding" ADD CONSTRAINT "PostEmbedding_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupEmbedding" ADD CONSTRAINT "GroupEmbedding_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CommunityGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserEmbedding" ADD CONSTRAINT "UserEmbedding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "PostEmbedding_embedding_hnsw" ON "PostEmbedding" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "GroupEmbedding_embedding_hnsw" ON "GroupEmbedding" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "UserEmbedding_embedding_hnsw" ON "UserEmbedding" USING hnsw ("embedding" vector_cosine_ops);
