import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AppConfigModule } from '../app/app-config.module';
import { JobsService } from './jobs.service';
import { JobsStatusService } from './jobs-status.service';
import { MOH_BACKGROUND_QUEUE } from './jobs.constants';

@Global()
@Module({
  imports: [
    AppConfigModule,
    BullModule.registerQueue({
      name: MOH_BACKGROUND_QUEUE,
    }),
  ],
  providers: [JobsService, JobsStatusService],
  exports: [JobsService, JobsStatusService, BullModule],
})
export class JobsModule {}

