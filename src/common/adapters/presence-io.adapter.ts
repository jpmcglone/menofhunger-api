import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import { AppConfigService } from '../../modules/app/app-config.service';

/**
 * Socket.IO adapter that applies same CORS as HTTP API (allowed origins + credentials).
 */
export class PresenceIoAdapter extends IoAdapter {
  constructor(
    private readonly app: INestApplicationContext,
    private readonly appConfig: AppConfigService,
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const origins = this.appConfig.allowedOrigins();
    const cors =
      origins.length > 0
        ? { origin: origins, credentials: true }
        : { origin: true, credentials: true };
    return super.createIOServer(port, { ...options, cors });
  }
}
