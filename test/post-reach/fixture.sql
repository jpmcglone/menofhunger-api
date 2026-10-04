CREATE TABLE "User" ("id" TEXT PRIMARY KEY);
CREATE TABLE "ViewerIdentity" ("anonId" TEXT PRIMARY KEY, "userId" TEXT REFERENCES "User"("id") ON DELETE CASCADE);
INSERT INTO "User" VALUES ('owner'), ('signed-in-guest'), ('reader');
CREATE TABLE "Post" ("id" TEXT PRIMARY KEY);
CREATE TABLE "PostView" ("postId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "impressionCount" INT NOT NULL DEFAULT 1, "lastImpressionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("postId", "userId"));
CREATE TABLE "PostAnonView" ("postId" TEXT NOT NULL, "anonId" TEXT NOT NULL,
  "impressionCount" INT NOT NULL DEFAULT 1, "lastImpressionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("postId", "anonId"));
