import { Module } from '@nestjs/common';
import { GroupChannelsModule } from '../group-channels/group-channels.module';
import { JobsModule } from '../jobs/jobs.module';
import { MessagesModule } from '../messages/messages.module';
import { TranscriptionService } from './transcription.service';

@Module({
  imports: [JobsModule, MessagesModule, GroupChannelsModule],
  providers: [TranscriptionService],
  exports: [TranscriptionService],
})
export class TranscriptionModule {}
