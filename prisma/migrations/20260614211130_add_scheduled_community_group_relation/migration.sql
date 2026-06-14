-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_scheduledCommunityGroupId_fkey" FOREIGN KEY ("scheduledCommunityGroupId") REFERENCES "CommunityGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
