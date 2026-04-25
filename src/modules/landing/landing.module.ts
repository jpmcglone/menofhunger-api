import { Module } from '@nestjs/common';
import { ArticlesModule } from '../articles/articles.module';
import { AppConfigModule } from '../app/app-config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LandingController } from './landing.controller';
import { LandingService } from './landing.service';

@Module({
  imports: [AppConfigModule, ArticlesModule, PrismaModule],
  controllers: [LandingController],
  providers: [LandingService],
  exports: [LandingService],
})
export class LandingModule {}
