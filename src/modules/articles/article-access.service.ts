import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ViewerContextService } from '../viewer/viewer-context.service';

@Injectable()
export class ArticleAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly viewer: ViewerContextService,
  ) {}

  /** Throws 404 unless the viewer may read the article (drafts are author-only; published follow visibility tiers). */
  async assertAccessible(articleId: string, viewerUserId?: string | null): Promise<void> {
    const article = await this.prisma.article.findUnique({
      where: { id: articleId },
      select: { id: true, isDraft: true, deletedAt: true, visibility: true, authorId: true },
    });
    if (!article || article.deletedAt) throw new NotFoundException('Article not found.');
    if (article.isDraft && article.authorId !== viewerUserId) {
      throw new NotFoundException('Article not found.');
    }
    if (!article.isDraft) {
      const viewerCtx = viewerUserId ? await this.viewer.getViewer(viewerUserId) : null;
      const allowed = this.viewer.allowedPostVisibilities(viewerCtx);
      if (!allowed.includes(article.visibility) && article.authorId !== viewerUserId) {
        throw new NotFoundException('Article not found.');
      }
    }
  }
}
