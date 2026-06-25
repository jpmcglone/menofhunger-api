-- Auto-accept any pending group invites for the Marv bot user.
-- Runs as part of the deploy that introduces group-membership gating for Marv.
-- Safe to re-run: UPDATE/INSERT are idempotent (ON CONFLICT DO NOTHING / WHERE status = 'pending').

-- 1. Resolve the Marv user id from config (stored as username = 'marv').
DO $$
DECLARE
  marv_id TEXT;
BEGIN
  SELECT id INTO marv_id FROM "User" WHERE username = 'marv' LIMIT 1;
  IF marv_id IS NULL THEN
    RAISE NOTICE 'accept_pending_marv_invites: marv user not found, skipping.';
    RETURN;
  END IF;

  -- 2. For every pending invite addressed to Marv, accept it.
  UPDATE "CommunityGroupInvite"
  SET    status       = 'accepted',
         "respondedAt" = NOW()
  WHERE  "inviteeUserId" = marv_id
    AND  status         = 'pending';

  -- 3. Upsert an active CommunityGroupMember row for each group that now has an
  --    accepted invite for Marv (covers both pre-existing pending rows and any
  --    that were just accepted in step 2).
  INSERT INTO "CommunityGroupMember" ("groupId", "userId", role, status, "createdAt", "updatedAt")
  SELECT DISTINCT
    cgi."groupId",
    marv_id,
    'member'::"CommunityGroupMemberRole",
    'active'::"CommunityGroupMemberStatus",
    NOW(),
    NOW()
  FROM   "CommunityGroupInvite" cgi
  WHERE  cgi."inviteeUserId" = marv_id
    AND  cgi.status         = 'accepted'
  ON CONFLICT ("groupId", "userId")
  DO UPDATE SET status = 'active'::"CommunityGroupMemberStatus", "updatedAt" = NOW()
    WHERE "CommunityGroupMember".status <> 'active'::"CommunityGroupMemberStatus";

  -- 4. Sync memberCount for any group whose count changed.
  UPDATE "CommunityGroup" cg
  SET    "memberCount" = (
    SELECT COUNT(*) FROM "CommunityGroupMember"
    WHERE  "groupId" = cg.id AND status = 'active'
  )
  WHERE cg.id IN (
    SELECT DISTINCT "groupId"
    FROM   "CommunityGroupInvite"
    WHERE  "inviteeUserId" = marv_id
      AND  status = 'accepted'
  );

  RAISE NOTICE 'accept_pending_marv_invites: done for marv_id=%', marv_id;
END;
$$;
