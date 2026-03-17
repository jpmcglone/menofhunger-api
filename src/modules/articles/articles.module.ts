import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ArticleViewsModule } from '../article-views/article-views.module';
import { ArticlesController } from './articles.controller';
import { ArticlesService } from './articles.service';
import { ArticlesTrendingScoreCron } from './articles-trending-score.cron';

@Module({
  imports: [AuthModule, NotificationsModule, RealtimeModule, ArticleViewsModule],
  controllers: [ArticlesController],
  providers: [ArticlesService, ArticlesTrendingScoreCron],
  exports: [ArticlesService, ArticlesTrendingScoreCron],
})
export class ArticlesModule {}
