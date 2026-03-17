-- User article tag preferences for weekly digest personalization.
CREATE TABLE "UserArticleTagPreference" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tag" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "UserArticleTagPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserArticleTagPreference_userId_tag_key" ON "UserArticleTagPreference"("userId", "tag");
CREATE INDEX "UserArticleTagPreference_userId_idx" ON "UserArticleTagPreference"("userId");
CREATE INDEX "UserArticleTagPreference_tag_idx" ON "UserArticleTagPreference"("tag");

ALTER TABLE "UserArticleTagPreference" ADD CONSTRAINT "UserArticleTagPreference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
