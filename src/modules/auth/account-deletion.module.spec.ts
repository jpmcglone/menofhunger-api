import 'reflect-metadata';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionFinalizeCron } from './account-deletion-finalize.cron';
import { AccountDeletionModule } from './account-deletion.module';
import { AccountDeletionService } from './account-deletion.service';
import { AppConfigModule } from '../app/app-config.module';
import { JobsModule } from '../jobs/jobs.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';

type Token = new (...args: never[]) => unknown;

const exportsOf = (mod: Token): unknown[] => Reflect.getMetadata('exports', mod) ?? [];
const importsOf = (mod: Token): Token[] => Reflect.getMetadata('imports', mod) ?? [];
const providersOf = (mod: Token): unknown[] => Reflect.getMetadata('providers', mod) ?? [];

/**
 * Static DI check: every constructor dependency of the module's controllers and providers must come from
 * the module's own providers, an imported module's exports, or a global module. Catches missing exports
 * and `undefined` tokens (the symptom of a load-time import cycle) without booting infrastructure.
 */
describe('AccountDeletionModule DI graph', () => {
  const globalModules = [PrismaModule, RedisModule, JobsModule, AppConfigModule] as Token[];
  const available = new Set<unknown>([
    ...providersOf(AccountDeletionModule),
    ...importsOf(AccountDeletionModule).flatMap((m) => exportsOf(m)),
    ...globalModules.flatMap((m) => exportsOf(m)),
  ]);

  it.each([AccountDeletionController, AccountDeletionService, AccountDeletionFinalizeCron])(
    'resolves every constructor dependency of %p',
    (target) => {
      const params: unknown[] = Reflect.getMetadata('design:paramtypes', target) ?? [];
      expect(params.length).toBeGreaterThan(0);
      for (const token of params) {
        expect(token).toBeDefined();
        expect(available.has(token)).toBe(true);
      }
    },
  );

  it('does not import a module that imports it back', () => {
    for (const mod of importsOf(AccountDeletionModule)) {
      expect(importsOf(mod)).not.toContain(AccountDeletionModule);
    }
  });
});
