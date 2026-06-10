import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PostsModule } from '../posts/posts.module';
import { TopicsModule } from '../topics/topics.module';
import { ArticlesModule } from '../articles/articles.module';
import { GroupsModule } from '../groups/groups.module';
import { HashtagsModule } from '../hashtags/hashtags.module';
import { FollowsModule } from '../follows/follows.module';
import { CheckinsModule } from '../checkins/checkins.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ExploreController } from './explore.controller';
import { ExploreService } from './explore.service';

@Module({
  imports: [
    AuthModule,
    PostsModule,
    TopicsModule,
    ArticlesModule,
    GroupsModule,
    HashtagsModule,
    FollowsModule,
    CheckinsModule,
    RealtimeModule,
  ],
  controllers: [ExploreController],
  providers: [ExploreService],
})
export class ExploreModule {}
