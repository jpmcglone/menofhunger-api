import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ChannelAccessService } from './channel-access.service';

/** Authorization is a leaf dependency shared by HTTP, badges and workers. */
@Module({ imports: [PrismaModule], providers: [ChannelAccessService], exports: [ChannelAccessService] })
export class ChannelAccessModule {}
