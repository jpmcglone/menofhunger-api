-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "crosspostChoices" JSONB,
ADD COLUMN     "scheduledRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scheduledPublishedPostId" TEXT;

-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "crosspostChoices" JSONB;

-- AlterTable
ALTER TABLE "PickaxConnection" ADD COLUMN     "authKind" TEXT NOT NULL DEFAULT 'credentials',
ADD COLUMN     "authorizedByUserId" TEXT,
ADD COLUMN     "generation" TEXT;

-- AlterTable
ALTER TABLE "XConnection" ADD COLUMN     "authorizedByUserId" TEXT,
ADD COLUMN     "generation" TEXT;

-- Backfill before enforcing NOT NULL on populated installations.
UPDATE "PickaxConnection" SET generation=md5(random()::text || "userId" || clock_timestamp()::text);
UPDATE "XConnection" SET generation=md5(random()::text || "userId" || clock_timestamp()::text);
ALTER TABLE "PickaxConnection" ALTER COLUMN generation SET NOT NULL;
ALTER TABLE "XConnection" ALTER COLUMN generation SET NOT NULL;

-- CreateTable
CREATE TABLE "PartnerClient" (
    "authorizationStartUrl" TEXT,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT,
    "secretEnc" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "logoutRedirectUris" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scopes" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "accountReadLimit" INTEGER NOT NULL DEFAULT 120,
    "clientReadLimit" INTEGER NOT NULL DEFAULT 1200,
    "webhookUrl" TEXT,
    "webhookSecretEnc" TEXT,
    "previousWebhookSecretEnc" TEXT,
    "webhookEvents" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerGrant" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PartnerGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerOidcRecord" (
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payloadEnc" TEXT NOT NULL,
    "grantId" TEXT,
    "uid" TEXT,
    "userCode" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "PartnerOidcRecord_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "PartnerEvent" (
    "dispatchedAt" TIMESTAMP(3),
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resourceKind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "version" BIGSERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerWebhookDelivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "lastStatus" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundDelivery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "resourceKind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "connectionGeneration" TEXT NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'create',
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "remoteId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XUsageReservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "month" TIMESTAMP(3) NOT NULL,
    "hasLink" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XUsageReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartnerGrant_userId_clientId_idx" ON "PartnerGrant"("userId", "clientId");

-- CreateIndex
CREATE INDEX "PartnerGrant_operatorUserId_idx" ON "PartnerGrant"("operatorUserId");

-- CreateIndex
CREATE INDEX "PartnerOidcRecord_grantId_idx" ON "PartnerOidcRecord"("grantId");

-- CreateIndex
CREATE INDEX "PartnerOidcRecord_uid_idx" ON "PartnerOidcRecord"("uid");

-- CreateIndex
CREATE INDEX "PartnerOidcRecord_userCode_idx" ON "PartnerOidcRecord"("userCode");

-- CreateIndex
CREATE INDEX "PartnerOidcRecord_expiresAt_idx" ON "PartnerOidcRecord"("expiresAt");

-- CreateIndex
CREATE INDEX "PartnerEvent_createdAt_idx" ON "PartnerEvent"("createdAt");

-- CreateIndex
CREATE INDEX "PartnerWebhookDelivery_status_nextAttemptAt_idx" ON "PartnerWebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerWebhookDelivery_eventId_grantId_key" ON "PartnerWebhookDelivery"("eventId", "grantId");

-- CreateIndex
CREATE INDEX "OutboundDelivery_status_nextAttemptAt_idx" ON "OutboundDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboundDelivery_userId_idx" ON "OutboundDelivery"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundDelivery_platform_resourceKind_resourceId_key" ON "OutboundDelivery"("platform", "resourceKind", "resourceId");

-- CreateIndex
CREATE INDEX "XUsageReservation_userId_month_status_idx" ON "XUsageReservation"("userId", "month", "status");

-- CreateIndex
CREATE INDEX "XUsageReservation_externalAccountId_month_status_idx" ON "XUsageReservation"("externalAccountId", "month", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Post_scheduledPublishedPostId_key" ON "Post"("scheduledPublishedPostId");


-- Audit first: conflicting legacy identities must be confirmed again; never pick a winner.
UPDATE "PickaxConnection" SET status='identity_conflict', "lastError"='Reconnect to confirm a unique Pickax identity.'
WHERE "pickaxUserId" IS NULL OR "pickaxUserId" IN (
 SELECT "pickaxUserId" FROM "PickaxConnection" WHERE "pickaxUserId" IS NOT NULL GROUP BY "pickaxUserId" HAVING count(*) > 1
);
CREATE UNIQUE INDEX "PickaxConnection_active_external_identity" ON "PickaxConnection" ("pickaxUserId") WHERE status='active' AND "pickaxUserId" IS NOT NULL;

-- Do not reset existing monthly consumption when the new allowance is enabled.
INSERT INTO "XUsageReservation" (id,"userId","externalAccountId",month,"hasLink",status,"createdAt")
SELECT 'x:' || c.kind::text || ':' || c."localId",c."userId",x."xUserId",date_trunc('month', c."createdAt" AT TIME ZONE 'UTC'),c."costMicros">15000,
 CASE WHEN c."remoteId" IS NOT NULL THEN 'sent' ELSE 'uncertain' END,c."createdAt"
FROM "XCrosspost" c JOIN "XConnection" x ON x."userId"=c."userId"
WHERE c."refundedAt" IS NULL AND c."createdAt">=date_trunc('month',NOW() AT TIME ZONE 'UTC')
ON CONFLICT DO NOTHING;

-- Metadata-only outbox inserts happen in the content transaction, including scheduled publication.
CREATE FUNCTION moh_partner_content_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE obj jsonb; prev jsonb; owner_id text; resource_kind text; removed boolean; event_type text;
 destination text; selected_mode text; generation text; external_id text; event_id text;
BEGIN
 obj=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END; prev=CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 IF TG_OP='UPDATE' AND (obj->'body',obj->'title',obj->'deletedAt',obj->'isDraft',obj->'visibility',obj->'crosspostChoices',obj->'editedAt',obj->'scheduledAt',obj->'communityGroupId')
   IS NOT DISTINCT FROM (prev->'body',prev->'title',prev->'deletedAt',prev->'isDraft',prev->'visibility',prev->'crosspostChoices',prev->'editedAt',prev->'scheduledAt',prev->'communityGroupId') THEN RETURN NEW; END IF;
 resource_kind=lower(TG_TABLE_NAME); owner_id=COALESCE(obj->>'userId',obj->>'authorId');
 removed=(TG_OP='DELETE' OR obj->>'deletedAt' IS NOT NULL OR obj->>'isDraft'='true' OR obj->>'visibility'<>'public' OR obj->>'communityGroupId' IS NOT NULL OR obj->>'scheduledAt' IS NOT NULL);
 IF removed AND (TG_OP='INSERT' OR prev->>'visibility'<>'public' OR prev->>'isDraft'='true' OR prev->>'deletedAt' IS NOT NULL OR prev->>'communityGroupId' IS NOT NULL) THEN RETURN NEW; END IF;
 event_type=resource_kind || CASE WHEN removed THEN '.removed' ELSE '.updated' END;
 event_id=md5(random()::text || clock_timestamp()::text || (obj->>'id'));
 INSERT INTO "PartnerEvent"(id,type,"userId","resourceKind","resourceId","createdAt")
 VALUES(event_id,event_type,owner_id,resource_kind,obj->>'id',now());
 IF resource_kind='post' AND obj->>'parentId' IS NOT NULL THEN
   INSERT INTO "PartnerEvent"(id,type,"userId","resourceKind","resourceId","createdAt")
   SELECT md5(random()::text || clock_timestamp()::text),CASE WHEN removed THEN 'comment.removed' ELSE 'comment.updated' END,p."userId",'post',obj->>'id',now() FROM "Post" p WHERE p.id=obj->>'parentId';
 END IF;
 IF removed THEN
   UPDATE "OutboundDelivery" SET action='remove',status='pending',version=version+1,"nextAttemptAt"=now(),"updatedAt"=now()
   WHERE "resourceKind"=resource_kind AND "resourceId"=obj->>'id' AND status NOT IN ('removed','cancelled');
   RETURN NEW;
 END IF;
 UPDATE "OutboundDelivery" SET action='update', status='pending',version=version+1,"nextAttemptAt"=now(),"updatedAt"=now()
 WHERE "resourceKind"=resource_kind AND "resourceId"=obj->>'id' AND status IN ('sent','sending') AND platform='pickax' AND action<>'remove';
 UPDATE "OutboundDelivery" SET "lastError"='MOH edit saved. The existing X copy is unchanged.',"updatedAt"=now() WHERE "resourceKind"=resource_kind AND "resourceId"=obj->>'id' AND status='sent' AND platform='x' AND action<>'remove';
 IF resource_kind='post' AND (obj->>'parentId' IS NOT NULL OR obj->>'quotedPostId' IS NOT NULL OR obj->>'repostedPostId' IS NOT NULL OR obj->>'kind'<>'regular' OR obj->>'boardOnly'='true') THEN RETURN NEW; END IF;
 FOREACH destination IN ARRAY ARRAY['pickax','x'] LOOP
   selected_mode=obj->'crosspostChoices'->>destination;
   IF selected_mode NOT IN ('link','native') OR selected_mode IS NULL THEN CONTINUE; END IF;
   generation=NULL; external_id=NULL;
   IF destination='pickax' THEN
     SELECT c.generation,c."pickaxUserId" INTO generation,external_id FROM "PickaxConnection" c WHERE c."userId"=owner_id AND c.status='active';
   ELSE
     SELECT c.generation,c."xUserId" INTO generation,external_id FROM "XConnection" c WHERE c."userId"=owner_id AND c.status='active';
   END IF;
   IF generation IS NULL OR external_id IS NULL THEN CONTINUE; END IF;
   INSERT INTO "OutboundDelivery"(id,"userId",platform,"resourceKind","resourceId","connectionGeneration","externalAccountId",mode,action,version,status,attempts,"nextAttemptAt","createdAt","updatedAt")
   VALUES(md5(random()::text || clock_timestamp()::text),owner_id,destination,resource_kind,obj->>'id',generation,external_id,selected_mode,'create',1,'pending',0,now(),now(),now())
   ON CONFLICT(platform,"resourceKind","resourceId") DO NOTHING;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER moh_partner_post_event AFTER INSERT OR UPDATE OR DELETE ON "Post" FOR EACH ROW EXECUTE FUNCTION moh_partner_content_event();
CREATE TRIGGER moh_partner_article_event AFTER INSERT OR UPDATE OR DELETE ON "Article" FOR EACH ROW EXECUTE FUNCTION moh_partner_content_event();

CREATE FUNCTION moh_partner_identity_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE obj jsonb; typ text; owner_id text; resource_kind text; resource_id text; event_id text;
BEGIN
 obj=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='User' THEN
   IF (NEW.username,NEW.name,NEW.bio,NEW."avatarKey",NEW."verifiedStatus",NEW."bannedAt") IS NOT DISTINCT FROM (OLD.username,OLD.name,OLD.bio,OLD."avatarKey",OLD."verifiedStatus",OLD."bannedAt") THEN RETURN NEW; END IF;
   typ=CASE WHEN NEW."verifiedStatus" IS DISTINCT FROM OLD."verifiedStatus" THEN 'verification.updated' ELSE 'profile.updated' END;
   owner_id=NEW.id; resource_kind=CASE WHEN typ='verification.updated' THEN 'verification' ELSE 'user' END; resource_id=NEW.id;
   IF NEW."bannedAt" IS NOT NULL AND OLD."bannedAt" IS NULL THEN
     UPDATE "PartnerGrant" SET "revokedAt"=now() WHERE ("userId"=NEW.id OR "operatorUserId"=NEW.id) AND "revokedAt" IS NULL;
     UPDATE "OutboundDelivery" SET action='remove', status='pending', version=version+1, "nextAttemptAt"=now(), "updatedAt"=now() WHERE "userId"=NEW.id AND status NOT IN ('removed','cancelled');
   END IF;
 ELSIF TG_TABLE_NAME='Follow' THEN
   typ=CASE WHEN TG_OP='DELETE' THEN 'follow.removed' ELSE 'follow.created' END;
   owner_id=obj->>'followingId'; resource_kind='user'; resource_id=obj->>'followerId';
 ELSE
   typ='mention.created'; owner_id=obj->>'userId'; resource_kind='post'; resource_id=obj->>'postId';
 END IF;
 event_id=md5(random()::text || clock_timestamp()::text);
 INSERT INTO "PartnerEvent"(id,type,"userId","resourceKind","resourceId","createdAt") VALUES(event_id,typ,owner_id,resource_kind,resource_id,now());
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER moh_partner_user_event AFTER UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION moh_partner_identity_event();
CREATE TRIGGER moh_partner_follow_event AFTER INSERT OR DELETE ON "Follow" FOR EACH ROW EXECUTE FUNCTION moh_partner_identity_event();
CREATE TRIGGER moh_partner_mention_event AFTER INSERT ON "PostMention" FOR EACH ROW EXECUTE FUNCTION moh_partner_identity_event();

-- Reauthorization must never replace the identity or generation of a pairing.
-- This also closes concurrent upsert callbacks that passed a preflight read.
CREATE FUNCTION moh_pairing_immutable_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_id text; after_id text;
BEGIN
 before_id=COALESCE(to_jsonb(OLD)->>'xUserId',to_jsonb(OLD)->>'pickaxUserId');
 after_id=COALESCE(to_jsonb(NEW)->>'xUserId',to_jsonb(NEW)->>'pickaxUserId');
 IF (before_id IS NOT NULL AND before_id IS DISTINCT FROM after_id) OR OLD.generation IS DISTINCT FROM NEW.generation THEN
   RAISE EXCEPTION 'Disconnect the existing pairing before switching identities' USING ERRCODE='23505';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER moh_pickax_pairing_identity BEFORE UPDATE ON "PickaxConnection" FOR EACH ROW EXECUTE FUNCTION moh_pairing_immutable_identity();
CREATE TRIGGER moh_x_pairing_identity BEFORE UPDATE ON "XConnection" FOR EACH ROW EXECUTE FUNCTION moh_pairing_immutable_identity();

CREATE FUNCTION moh_partner_grant_revoked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL THEN
   INSERT INTO "PartnerEvent"(id,type,"userId","resourceKind","resourceId","createdAt")
   VALUES('revoked:' || NEW.id,'connection.revoked',NEW."userId",'connection',NEW.id,now());
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER moh_partner_revocation AFTER UPDATE ON "PartnerGrant" FOR EACH ROW EXECUTE FUNCTION moh_partner_grant_revoked();

CREATE FUNCTION moh_partner_article_comment_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text; obj jsonb; removed boolean;
BEGIN
 obj=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_OP='UPDATE' AND (NEW.body,NEW."deletedAt") IS NOT DISTINCT FROM (OLD.body,OLD."deletedAt") THEN RETURN NEW; END IF;
 removed=TG_OP='DELETE' OR obj->>'deletedAt' IS NOT NULL;
 IF TG_OP='INSERT' AND removed THEN RETURN NEW; END IF;
 SELECT a."authorId" INTO owner_id FROM "Article" a WHERE a.id=obj->>'articleId' AND a.visibility='public' AND NOT a."isDraft" AND a."deletedAt" IS NULL;
 IF owner_id IS NULL THEN RETURN NEW; END IF;
 INSERT INTO "PartnerEvent"(id,type,"userId","resourceKind","resourceId","createdAt")
 VALUES(md5(random()::text || clock_timestamp()::text),CASE WHEN removed THEN 'comment.removed' ELSE 'comment.updated' END,owner_id,'article_comment',obj->>'id',now());
 RETURN NEW;
END $$;
CREATE TRIGGER moh_partner_article_comment AFTER INSERT OR UPDATE OR DELETE ON "ArticleComment" FOR EACH ROW EXECUTE FUNCTION moh_partner_article_comment_event();

-- Existing remote mappings must take part in removal and duplicate prevention too.
UPDATE "PickaxConnection" c SET "authorizedByUserId"=c."userId" FROM "User" u WHERE u.id=c."userId" AND u."accountKind"='person';
UPDATE "XConnection" c SET "authorizedByUserId"=c."userId" FROM "User" u WHERE u.id=c."userId" AND u."accountKind"='person';
INSERT INTO "OutboundDelivery"(id,"userId",platform,"resourceKind","resourceId","connectionGeneration","externalAccountId",mode,status,"remoteId","createdAt","updatedAt")
SELECT 'legacy-pickax-' || m.id,m."userId",'pickax',m.kind::text,m."localId",c.generation,c."pickaxUserId",m.mode::text,
 CASE WHEN m."remoteId" IS NOT NULL THEN 'sent' ELSE 'needs_attention' END,m."remoteId",m."createdAt",now()
FROM "PickaxCrosspost" m JOIN "PickaxConnection" c ON c."userId"=m."userId" WHERE c.status='active' AND c."pickaxUserId" IS NOT NULL
ON CONFLICT(platform,"resourceKind","resourceId") DO NOTHING;
INSERT INTO "OutboundDelivery"(id,"userId",platform,"resourceKind","resourceId","connectionGeneration","externalAccountId",mode,status,"remoteId","createdAt","updatedAt")
SELECT 'legacy-x-' || m.id,m."userId",'x',m.kind::text,m."localId",c.generation,c."xUserId",m.mode::text,
 CASE WHEN m."remoteId" IS NOT NULL THEN 'sent' ELSE 'needs_attention' END,m."remoteId",m."createdAt",now()
FROM "XCrosspost" m JOIN "XConnection" c ON c."userId"=m."userId"
ON CONFLICT(platform,"resourceKind","resourceId") DO NOTHING;

-- Revoke and erase encrypted partner state before either human or page deletion.
CREATE FUNCTION moh_partner_account_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM "PartnerOidcRecord" WHERE "grantId" IN (SELECT id FROM "PartnerGrant" WHERE "userId"=OLD.id OR "operatorUserId"=OLD.id);
 DELETE FROM "PartnerWebhookDelivery" WHERE "grantId" IN (SELECT id FROM "PartnerGrant" WHERE "userId"=OLD.id OR "operatorUserId"=OLD.id);
 DELETE FROM "PartnerGrant" WHERE "userId"=OLD.id OR "operatorUserId"=OLD.id;
 DELETE FROM "PartnerEvent" WHERE "userId"=OLD.id;
 UPDATE "OutboundDelivery" SET status='cancelled',"lastError"='The original account no longer exists.',"updatedAt"=now() WHERE "userId"=OLD.id AND status NOT IN ('sent','removed');
 RETURN OLD;
END $$;
CREATE TRIGGER moh_partner_account_delete BEFORE DELETE ON "User" FOR EACH ROW EXECUTE FUNCTION moh_partner_account_erasure();

-- One current read authorization per application/resource account; reauthorization replaces it.
CREATE UNIQUE INDEX "PartnerGrant_active_account_client" ON "PartnerGrant"("userId","clientId") WHERE "revokedAt" IS NULL;
