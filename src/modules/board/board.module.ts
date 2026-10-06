import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiUtilityModule } from '../ai/ai-utility.module';
import { LinkMetadataModule } from '../link-metadata/link-metadata.module';
import { PickaxModule } from '../pickax/pickax.module';
import { XModule } from '../x/x.module';
import { PostsModule } from '../posts/posts.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { BoardController } from './board.controller';
import { BoardService } from './board.service';
import { BoardTaggerService } from './board-tagger.service';
import { BoardSideEffectsHandler } from './board-side-effects.handler';

@Module({
  imports: [AuthModule, PostsModule, RealtimeModule, AiUtilityModule, LinkMetadataModule, PickaxModule, XModule],
  controllers: [BoardController],
  providers: [BoardService, BoardTaggerService, BoardSideEffectsHandler],
  exports: [BoardService],
})
export class BoardModule {}
