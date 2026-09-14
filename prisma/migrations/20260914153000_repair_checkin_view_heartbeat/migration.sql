-- Check-in cmtxi7n9p002ao92aj5j9e6hm had 5 unique people and ~1906 total views
-- because iOS re-reported every 30s while the row stayed on screen. Reset
-- per-person impression counts and the denormalized total to unique people.

UPDATE "PostView" SET "impressionCount" = 1
WHERE "postId" = 'cmtxi7n9p002ao92aj5j9e6hm' AND "impressionCount" > 1;

UPDATE "PostAnonView" SET "impressionCount" = 1
WHERE "postId" = 'cmtxi7n9p002ao92aj5j9e6hm' AND "impressionCount" > 1;

UPDATE "Post" SET "totalViewCount" = "viewerCount"
WHERE id = 'cmtxi7n9p002ao92aj5j9e6hm';
