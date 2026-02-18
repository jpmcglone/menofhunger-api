import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PostsModule } from '../posts/posts.module';
import { UsersModule } from '../users/users.module';
import { ViewerContextModule } from '../viewer/viewer-context.module';
import { CheckinsController } from './checkins.controller';
import { CheckinsService } from './checkins.service';

@Module({
  imports: [AuthModule, PrismaModule, PostsModule, UsersModule, ViewerContextModule],
  controllers: [CheckinsController],
  providers: [CheckinsService],
})
export class CheckinsModule {}

