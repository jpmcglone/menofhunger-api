import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AppConfigModule } from '../app/app-config.module';
import { ScriptureController } from './scripture.controller';
import { ScriptureService } from './scripture.service';

@Module({
  imports: [AuthModule, AppConfigModule],
  controllers: [ScriptureController],
  providers: [ScriptureService],
  exports: [ScriptureService],
})
export class ScriptureModule {}
