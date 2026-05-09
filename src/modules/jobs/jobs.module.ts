import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AppConfigModule } from '../app/app-config.module';
import { JobsService } from './jobs.service';
import { JobsStatusService } from './jobs-status.service';
import { MOH_BACKGROUND_QUEUE, MOH_MARVIN_QUEUE } from './jobs.constants';

@Global()
@Module({
  imports: [
    AppConfigModule,
    BullModule.registerQueue({
      name: MOH_BACKGROUND_QUEUE,
    }),
    // Marv has its own queue so its worker concurrency is independent of the cron-heavy
    // background queue. See MarvinProcessor for the consumer side.
    BullModule.registerQueue({
      name: MOH_MARVIN_QUEUE,
    }),
  ],
  providers: [JobsService, JobsStatusService],
  exports: [JobsService, JobsStatusService, BullModule],
})
export class JobsModule {}

