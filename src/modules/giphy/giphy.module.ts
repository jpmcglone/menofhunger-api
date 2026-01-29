import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GiphyController } from './giphy.controller';

@Module({
  imports: [AuthModule],
  controllers: [GiphyController],
})
export class GiphyModule {}

