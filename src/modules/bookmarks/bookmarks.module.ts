import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PresenceModule } from '../presence/presence.module';
import { BookmarksController } from './bookmarks.controller';
import { BookmarksService } from './bookmarks.service';

@Module({
  imports: [AuthModule, PresenceModule],
  controllers: [BookmarksController],
  providers: [BookmarksService],
})
export class BookmarksModule {}

