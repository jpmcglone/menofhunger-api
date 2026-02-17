import { Module } from '@nestjs/common';
import { DailyContentService } from './daily-content.service';
import { DailyContentCron } from './daily-content.cron';
import { JobsModule } from '../jobs/jobs.module';
import { AppConfigModule } from '../app/app-config.module';
import { Websters1828Module } from '../websters1828/websters1828.module';

@Module({
  imports: [JobsModule, AppConfigModule, Websters1828Module],
  providers: [DailyContentService, DailyContentCron],
  exports: [DailyContentService, DailyContentCron],
})
export class DailyContentModule {}

