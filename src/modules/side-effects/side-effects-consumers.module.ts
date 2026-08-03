import { Module } from '@nestjs/common';
import { AppConfigModule } from '../app/app-config.module';
import { SideEffectsModule } from './side-effects.module';
import { SideEffectsProcessor } from './side-effects.processor';

/**
 * Worker-only module: gated by `RUN_JOB_CONSUMERS` in `AppModule` so an API-only service can
 * produce side effects without consuming them.
 *
 * It imports no domain modules on purpose. The processor resolves work through
 * `SideEffectsRegistry`, and handlers register from their own domain modules (which `AppModule`
 * always imports), so there is nothing to wire here as features are added.
 */
@Module({
  imports: [AppConfigModule, SideEffectsModule],
  providers: [SideEffectsProcessor],
})
export class SideEffectsConsumersModule {}
