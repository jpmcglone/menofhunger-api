import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { UploadsController } from './uploads.controller';
import { UploadsStorageService } from './uploads-storage.service';
import { UploadsPostMediaService } from './uploads-post-media.service';
import { UploadsArticleAssetsService } from './uploads-article-assets.service';
import { UploadsService } from './uploads.service';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule],
  controllers: [UploadsController],
  providers: [UploadsStorageService, UploadsPostMediaService, UploadsArticleAssetsService, UploadsService],
  exports: [UploadsService],
})
export class UploadsModule {}

