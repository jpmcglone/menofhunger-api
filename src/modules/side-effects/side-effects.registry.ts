import { Injectable, Logger } from '@nestjs/common';
import type { SideEffectName, SideEffectPayloads } from './side-effects.constants';

export type SideEffectHandler<K extends SideEffectName> = (
  payload: SideEffectPayloads[K],
) => Promise<void>;

/**
 * Name → handler lookup for side effects.
 *
 * Handlers register themselves from their own domain module (`onModuleInit`), which keeps two
 * properties that matter:
 *
 *   1. **No processor to update.** Adding a side effect never touches a central switch
 *      statement, so the seam doesn't rot as features are added.
 *   2. **Handlers resolve in every process.** Because they live in domain modules (always
 *      imported by `AppModule`) rather than the worker-only consumers module, the API process
 *      can still execute a handler in-process when a Redis enqueue fails.
 */
@Injectable()
export class SideEffectsRegistry {
  private readonly logger = new Logger(SideEffectsRegistry.name);
  private readonly handlers = new Map<string, SideEffectHandler<SideEffectName>>();

  register<K extends SideEffectName>(name: K, handler: SideEffectHandler<K>): void {
    if (this.handlers.has(name)) {
      // Registering twice means two providers claim the same effect — the second would
      // silently win. Surface it rather than shipping a mystery.
      this.logger.warn(`[side-effects] Handler for "${name}" registered more than once; keeping the first.`);
      return;
    }
    this.handlers.set(name, handler as SideEffectHandler<SideEffectName>);
  }

  get<K extends SideEffectName>(name: K): SideEffectHandler<K> | null {
    return (this.handlers.get(name) as SideEffectHandler<K> | undefined) ?? null;
  }

  /** Registered effect names. Used by the admin queue readout and the guardrail test. */
  names(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
