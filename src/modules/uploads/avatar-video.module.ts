import { Injectable, Logger, Module } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppConfigService } from '../app/app-config.service';
import { BullModule, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AVATAR_VIDEO_QUEUE } from './avatar-video-policy';
import { AvatarVideoService } from './avatar-video.service';
import { AvatarVideoTranscoder } from './avatar-video-transcoder';
import { AvatarVideoController } from './avatar-video.controller';

@Injectable()
export class AvatarVideoCleanup {
  private readonly logger = new Logger(AvatarVideoCleanup.name);
  constructor(private readonly videos: AvatarVideoService, private readonly config: AppConfigService) {}
  @Cron('17 * * * *')
  async expire() {
    if (!this.config.runSchedulers()) return;
    try { await this.videos.expireUploads(); }
    catch { this.logger.warn('Avatar upload cleanup failed; it will retry on the next sweep.'); }
  }
}

@Module({
  imports: [PrismaModule, AuthModule, UsersModule, BullModule.registerQueue({ name: AVATAR_VIDEO_QUEUE })],
  controllers: [AvatarVideoController], providers: [AvatarVideoService, AvatarVideoTranscoder, AvatarVideoCleanup], exports: [AvatarVideoService],
})
export class AvatarVideoModule {}

@Processor(AVATAR_VIDEO_QUEUE, { concurrency: 1 })
export class AvatarVideoProcessor extends WorkerHost {
  constructor(private readonly videos: AvatarVideoService) { super(); }
  override async process(job: Job<{ id: string }>) {
    try { await this.videos.process(job.data.id); }
    catch (error) {
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) await this.videos.fail(job.data.id);
      throw error;
    }
  }
}

@Module({ imports: [AvatarVideoModule], providers: [AvatarVideoProcessor] })
export class AvatarVideoConsumersModule {}
