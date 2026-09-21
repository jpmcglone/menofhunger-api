import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from '../app/app-config.module';
import { AiUtilityService } from './ai-utility.service';

/**
 * Global OpenAI utility (no member Marv persona). Posts and admin inject this
 * without importing MarvinModule — MarvinModule already imports PostsModule.
 */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [AiUtilityService],
  exports: [AiUtilityService],
})
export class AiUtilityModule {}
