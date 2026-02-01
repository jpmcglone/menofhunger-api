import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FollowsModule } from '../follows/follows.module';
import { UsersController } from './users.controller';

@Module({
  imports: [AuthModule, FollowsModule],
  controllers: [UsersController],
})
export class UsersModule {}

