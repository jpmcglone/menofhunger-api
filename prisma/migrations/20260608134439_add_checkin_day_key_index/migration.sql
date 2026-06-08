-- CreateIndex
CREATE INDEX "Post_kind_checkinDayKey_createdAt_idx" ON "Post"("kind", "checkinDayKey", "createdAt" DESC);
