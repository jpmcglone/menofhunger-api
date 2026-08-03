import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from '../app/app-config.module';
import { MOH_SIDE_EFFECTS_QUEUE } from './side-effects.constants';
import { SideEffectsRegistry } from './side-effects.registry';
import { SideEffectsService } from './side-effects.service';

/**
 * Global so any mutation service can inject `SideEffectsService` without module plumbing —
 * the point of the seam is that reaching for it is never the hard path.
 *
 * Note this module has no domain dependencies: handlers register themselves into
 * `SideEffectsRegistry` from their own modules, which is what keeps this dependency-free
 * (and cycle-free) while still letting the fallback path resolve handlers in the API process.
 */
@Global()
@Module({
  imports: [
    AppConfigModule,
    BullModule.registerQueue({
      name: MOH_SIDE_EFFECTS_QUEUE,
    }),
  ],
  providers: [SideEffectsRegistry, SideEffectsService],
  exports: [SideEffectsRegistry, SideEffectsService, BullModule],
})
export class SideEffectsModule {}
