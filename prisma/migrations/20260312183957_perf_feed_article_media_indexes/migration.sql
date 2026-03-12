-- CreateIndex
CREATE INDEX "Article_deletedAt_isDraft_visibility_publishedAt_id_idx" ON "Article"("deletedAt", "isDraft", "visibility", "publishedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Article_deletedAt_isDraft_visibility_trendingScore_publishe_idx" ON "Article"("deletedAt", "isDraft", "visibility", "trendingScore" DESC, "publishedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Article_authorId_deletedAt_isDraft_visibility_publishedAt_i_idx" ON "Article"("authorId", "deletedAt", "isDraft", "visibility", "publishedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Article_authorId_deletedAt_isDraft_visibility_trendingScore_idx" ON "Article"("authorId", "deletedAt", "isDraft", "visibility", "trendingScore" DESC, "publishedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ArticleComment_article_parent_deleted_created_desc_idx" ON "ArticleComment"("articleId", "parentId", "deletedAt", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ArticleComment_article_parent_deleted_created_asc_idx" ON "ArticleComment"("articleId", "parentId", "deletedAt", "createdAt" ASC, "id" ASC);

-- CreateIndex
CREATE INDEX "Post_deletedAt_visibility_createdAt_id_idx" ON "Post"("deletedAt", "visibility", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Post_userId_deletedAt_visibility_createdAt_id_idx" ON "Post"("userId", "deletedAt", "visibility", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Post_userId_parentId_deletedAt_visibility_createdAt_id_idx" ON "Post"("userId", "parentId", "deletedAt", "visibility", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Post_deletedAt_visibility_trendingScore_createdAt_id_idx" ON "Post"("deletedAt", "visibility", "trendingScore" DESC, "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "PostMedia_source_kind_deletedAt_createdAt_id_idx" ON "PostMedia"("source", "kind", "deletedAt", "createdAt" DESC, "id" DESC);
