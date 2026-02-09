import { Module } from '@nestjs/common';
import { LinkMetadataController } from './link-metadata.controller';
import { LinkMetadataService } from './link-metadata.service';
import { LinkMetadataCron } from './link-metadata.cron';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [LinkMetadataController],
  providers: [LinkMetadataService, LinkMetadataCron],
  exports: [LinkMetadataService, LinkMetadataCron],
})
export class LinkMetadataModule {}
