import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { BookmarksController } from './bookmarks.controller';
import { BookmarksService } from './bookmarks.service';

@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [BookmarksController],
  providers: [BookmarksService],
})
export class BookmarksModule {}

