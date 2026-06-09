import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { AppConfigService } from '../../app/app-config.service';
import { PresenceService } from '../presence.service';

/**
 * Shared gateway context: holds the live Socket.IO server reference (set once
 * in `afterInit`) and the socket-targeting helpers every handler module needs.
 */
@Injectable()
export class GatewayContextService {
  private readonly logger = new Logger(GatewayContextService.name);
  readonly logPresenceVerbose: boolean;
  private _server: Server | null = null;

  constructor(
    appConfig: AppConfigService,
    private readonly presence: PresenceService,
  ) {
    this.logPresenceVerbose = !appConfig.isProd();
  }

  setServer(server: Server): void {
    this._server = server;
  }

  get server(): Server {
    // Handlers only run after afterInit, so the ref is always set in practice.
    return this._server as Server;
  }

  /** Sockets that care about this user's presence (subscribers + online-feed listeners). */
  getTargetsForUser(userId: string): Set<string> {
    return new Set([
      ...this.presence.getSubscribers(userId),
      ...this.presence.getOnlineFeedListeners(),
    ]);
  }

  /** Status changes also go to the user's own sockets (other tabs/devices). */
  getStatusTargetsForUser(userId: string): Set<string> {
    return new Set([
      ...this.presence.getSubscribers(userId),
      ...this.presence.getOnlineFeedListeners(),
      ...this.presence.getSocketIdsForUser(userId),
    ]);
  }

  emitToSockets(socketIds: Iterable<string>, event: string, payload: unknown): void {
    const ids = [...socketIds];
    if (this.logPresenceVerbose) {
      this.logger.debug(`[presence] EMIT_OUT event=${event} to ${ids.length} sockets`);
    }
    for (const id of ids) {
      const socket = this.server.sockets.sockets.get(id);
      socket?.emit(event, payload);
    }
  }
}
