import { Module } from '@nestjs/common';
import { JobsModule } from './jobs.module';
import { JobsProcessor } from './jobs.processor';
import { PostsModule } from '../posts/posts.module';
import { HashtagsModule } from '../hashtags/hashtags.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthModule } from '../auth/auth.module';
import { SearchModule } from '../search/search.module';
import { LinkMetadataModule } from '../link-metadata/link-metadata.module';

/**
 * Worker-only module: all BullMQ processors live here so we can disable job consumption
 * in the API service by not importing this module (RUN_JOB_CONSUMERS=false).
 *
 * For now, we only wire the module; processors are added in the next step.
 */
@Module({
  imports: [JobsModule, PostsModule, HashtagsModule, NotificationsModule, AuthModule, SearchModule, LinkMetadataModule],
  providers: [JobsProcessor],
})
export class JobsConsumersModule {}

