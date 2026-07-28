import { Module } from '@nestjs/common';
import { DailyContentService } from './daily-content.service';
import { DailyContentCron } from './daily-content.cron';
import { DailyContentController } from './daily-content.controller';
import { JobsModule } from '../jobs/jobs.module';
import { AppConfigModule } from '../app/app-config.module';
import { Websters1828Module } from '../websters1828/websters1828.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [JobsModule, AppConfigModule, Websters1828Module, RealtimeModule],
  providers: [DailyContentService, DailyContentCron],
  controllers: [DailyContentController],
  exports: [DailyContentService, DailyContentCron],
})
export class DailyContentModule {}

