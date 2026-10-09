import { PostsModule } from '../posts/posts.module';
import { ArticleDiscoveryService } from './article-discovery.service';
import { ArticleEngagementService } from './article-engagement.service';
import { ArticleCommentsService } from './article-comments.service';
import { ArticleAccessService } from './article-access.service';
import { ArticleFeedService } from './article-feed.service';
import { ArticleCommentWriterService } from './article-comment-writer.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ArticleViewsModule } from '../article-views/article-views.module';
import { BoardModule } from '../board/board.module';
import { PickaxModule } from '../pickax/pickax.module';
import { XModule } from '../x/x.module';
import { ArticlesController } from './articles.controller';
import { ArticlesService } from './articles.service';
import { ArticlesRankingService } from './articles-ranking.service';
import { ArticlesSideEffectsHandler } from './articles-side-effects.handler';
import { ArticlesTrendingScoreCron } from './articles-trending-score.cron';

@Module({
  imports: [PostsModule, AuthModule, NotificationsModule, RealtimeModule, ArticleViewsModule, BoardModule, PickaxModule, XModule],
  controllers: [ArticlesController],
  providers: [ArticleAccessService, ArticleFeedService, ArticleCommentWriterService, ArticleDiscoveryService, ArticleEngagementService, ArticleCommentsService, ArticlesService, ArticlesRankingService, ArticlesSideEffectsHandler, ArticlesTrendingScoreCron],
  exports: [ArticlesService, ArticlesRankingService, ArticlesTrendingScoreCron],
})
export class ArticlesModule {}
