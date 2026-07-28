import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { Websters1828Controller } from './websters1828.controller';
import { Websters1828Service } from './websters1828.service';

@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [Websters1828Controller],
  providers: [Websters1828Service],
  exports: [Websters1828Service],
})
export class Websters1828Module {}

