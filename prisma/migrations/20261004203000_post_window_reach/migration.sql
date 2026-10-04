-- No historical backfill: lifetime counts cannot be assigned to specific days.
CREATE TABLE "PostReachDay" (
  "postId" TEXT NOT NULL,
  "actorKey" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "userId" TEXT,
  "anonId" TEXT,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "PostReachDay_pkey" PRIMARY KEY ("postId", "actorKey", "day"),
  CONSTRAINT "PostReachDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PostReachDay_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PostReachDay_day_postId_idx" ON "PostReachDay"("day", "postId");
CREATE TABLE "PostReachTracking" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "PostReachTracking" ("id") VALUES ('posts');

-- Runs in the same transaction as accepted view counters, including batch and self views.
-- Deleting an anonymous lifetime row during sign-in must not erase its historical impressions.
CREATE FUNCTION record_post_reach_day() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  delta INTEGER;
  actor TEXT;
  uid TEXT;
  aid TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    delta := NEW."impressionCount";
  ELSE
    delta := NEW."impressionCount" - OLD."impressionCount";
  END IF;
  IF delta <= 0 THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'PostView' THEN
    uid := NEW."userId";
    actor := 'u:' || uid;
  ELSE
    aid := NEW."anonId";
    actor := 'a:' || aid;
  END IF;
  INSERT INTO "PostReachDay" ("postId", "actorKey", "day", "userId", "anonId", "impressions")
  VALUES (NEW."postId", actor,
    (NEW."lastImpressionAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date,
    uid, aid, delta)
  ON CONFLICT ("postId", "actorKey", "day") DO UPDATE
    SET "impressions" = "PostReachDay"."impressions" + EXCLUDED."impressions";
  RETURN NEW;
END;
$$;
CREATE TRIGGER post_view_reach_day AFTER INSERT OR UPDATE OF "impressionCount" ON "PostView"
FOR EACH ROW EXECUTE FUNCTION record_post_reach_day();
CREATE TRIGGER post_anon_view_reach_day AFTER INSERT OR UPDATE OF "impressionCount" ON "PostAnonView"
FOR EACH ROW EXECUTE FUNCTION record_post_reach_day();

CREATE INDEX "PostReachDay_userId_idx" ON "PostReachDay"("userId");
CREATE INDEX "PostReachDay_anonId_idx" ON "PostReachDay"("anonId");
-- Erasing a linked identity also erases its historical anonymous attribution.
CREATE FUNCTION erase_post_reach_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "PostReachDay" WHERE "anonId" = OLD."anonId";
  RETURN OLD;
END;
$$;
CREATE TRIGGER viewer_identity_reach_erasure AFTER DELETE ON "ViewerIdentity"
FOR EACH ROW EXECUTE FUNCTION erase_post_reach_identity();
