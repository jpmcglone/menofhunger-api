import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CashtagsController } from './cashtags.controller';
import { TickerService } from './ticker.service';
import { TickerIngestCron } from './ticker-ingest.cron';

@Module({
  imports: [PrismaModule],
  controllers: [CashtagsController],
  providers: [TickerService, TickerIngestCron],
  exports: [TickerService, TickerIngestCron],
})
export class CashtagsModule {}
