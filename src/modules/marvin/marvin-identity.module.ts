import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from '../app/app-config.module';
import { MarvinBotIdentityService } from './services/marvin-bot-identity.service';

/**
 * Tiny global module for {@link MarvinBotIdentityService}.
 *
 * Why not just live in `MarvinModule`? Because `MarvinModule` imports
 * `MessagesModule` and `PostsModule` (Marv replies via those services), which means
 * those modules cannot in turn import `MarvinModule` without a cycle. But they
 * still need to know **who Marv is** at the moment a user DMs him or @-mentions
 * him in a thread — otherwise the enqueue gates fall back to env-only resolution
 * and silently no-op when `MARV_USER_ID` isn't pinned in `.env`.
 *
 * `MarvinBotIdentityService` only depends on `PrismaService` (global) and
 * `AppConfigService` (global), so we expose it as its own `@Global()` provider.
 * `MessagesService` / `PostsService` can inject it directly without creating a
 * dependency cycle.
 */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [MarvinBotIdentityService],
  exports: [MarvinBotIdentityService],
})
export class MarvinIdentityModule {}
