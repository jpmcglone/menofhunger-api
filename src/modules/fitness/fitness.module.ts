import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VerifiedGuard } from '../auth/verified.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { PostsModule } from '../posts/posts.module';
import { RedisModule } from '../redis/redis.module';
import { FitnessController } from './fitness.controller';
import { FitnessService } from './fitness.service';
import { FitnessStravaService } from './fitness-strava.service';
import { FitnessIngestService } from './fitness-ingest.service';
import { FitnessStravaGuard } from './fitness-strava.guard';

@Module({
  imports: [AuthModule, PrismaModule, PostsModule, RedisModule],
  controllers: [FitnessController],
  providers: [FitnessService, FitnessStravaService, FitnessIngestService, VerifiedGuard, FitnessStravaGuard],
  exports: [FitnessService],
})
export class FitnessModule {}
