import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  OnGatewayInit,
} from '@nestjs/websockets';
import { OnModuleDestroy } from '@nestjs/common';
import { Server, type Socket } from 'socket.io';
import { PresenceService } from './presence.service';
import { PresenceRealtimeService } from './presence-realtime.service';
import { PresenceRedisStateService } from './presence-redis-state.service';
import type {
  ArticlesSubscribePayloadDto,
  GroupsSubscribePayloadDto,
  PostsSubscribePayloadDto,
  SpaceLobbyCountsDto,
  UsersSpaceChangedPayloadDto,
} from '../../common/dto';
import { WsEventNames } from '../../common/dto';
import { GatewayContextService } from './gateway/gateway-context.service';
import { PresenceStatusHandler } from './gateway/gateway-presence.handler';
import { SpacesGatewayHandler } from './gateway/gateway-spaces.handler';
import { RadioGatewayHandler } from './gateway/gateway-radio.handler';
import { ContentSubscriptionsHandler } from './gateway/gateway-subscriptions.handler';
import { MessagingGatewayHandler } from './gateway/gateway-messaging.handler';

/**
 * Single Socket.IO gateway for the app. All domain logic lives in the injected
 * handler modules under `./gateway/`; this class only routes events to them and
 * owns the cross-instance Redis event subscription.
 */
@WebSocketGateway({
  path: '/socket.io',
  // CORS is controlled by PresenceIoAdapter (uses AppConfigService allowedOrigins).
  // Do not set cors here; it would be ignored by the adapter and mislead reviewers.
})
export class PresenceGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private presenceEventUnsubscribe: (() => void) | null = null;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly presence: PresenceService,
    private readonly presenceRedis: PresenceRedisStateService,
    private readonly realtime: PresenceRealtimeService,
    private readonly context: GatewayContextService,
    private readonly presenceHandler: PresenceStatusHandler,
    private readonly spacesHandler: SpacesGatewayHandler,
    private readonly radioHandler: RadioGatewayHandler,
    private readonly subscriptionsHandler: ContentSubscriptionsHandler,
    private readonly messagingHandler: MessagingGatewayHandler,
  ) {}

  afterInit(server: Server): void {
    this.realtime.setServer(server);
    this.context.setServer(server);

    const myInstanceId = this.presenceRedis.getInstanceId();
    this.presenceEventUnsubscribe = this.presenceRedis.onEvent((evt) => {
      if (!evt) return;
      if (evt.instanceId === myInstanceId) return;
      if (evt.type === 'online') void this.presenceHandler.emitOnline(evt.userId);
      else if (evt.type === 'offline') this.presenceHandler.emitOffline(evt.userId);
      else if (evt.type === 'idle') this.presenceHandler.emitIdle(evt.userId);
      else if (evt.type === 'active') this.presenceHandler.emitActive(evt.userId);
      else if (evt.type === 'emitToUser') {
        const e = evt.event.trim();
        if (!e) return;
        this.presence.emitToUser(this.context.server, evt.userId, e, evt.payload);
      } else if (evt.type === 'emitToRoom') {
        const room = evt.room.trim();
        const e = evt.event.trim();
        if (!room || !e) return;
        this.context.server.to(room).emit(e, evt.payload);
      } else if (evt.type === 'spacesLobbyCounts') {
        const payload: SpaceLobbyCountsDto = { countsBySpaceId: evt.countsBySpaceId ?? {} };
        this.context.server.emit('spaces:lobbyCounts', payload);
      } else if (evt.type === 'userSpaceChanged') {
        if (!evt.userId) return;
        const payload: UsersSpaceChangedPayloadDto = {
          userId: evt.userId,
          spaceId: evt.spaceId ?? null,
          previousSpaceId: evt.previousSpaceId,
        };
        const targets = this.context.getTargetsForUser(evt.userId);
        this.context.emitToSockets(targets, WsEventNames.usersSpaceChanged, payload);
      } else if (evt.type === 'userStatusChanged') {
        const targets = this.context.getStatusTargetsForUser(evt.userId);
        this.context.emitToSockets(targets, evt.event, evt.payload);
      }
    });
  }

  onModuleDestroy(): void {
    this.presenceEventUnsubscribe?.();
    this.presenceEventUnsubscribe = null;
  }

  // ─── Connection lifecycle ───────────────────────────────────────────

  async handleConnection(client: Socket): Promise<void> {
    await this.presenceHandler.handleConnection(client);
  }

  handleDisconnect(client: Socket): void {
    // Resolve the user before presence unregister wipes the mapping, so the
    // spaces cleanup can still attribute the leave to the right user.
    const fallbackUserId =
      (client.data as { userId?: string })?.userId ??
      this.presence.getUserIdForSocket(client.id) ??
      '';

    this.presenceHandler.handleDisconnect(client);
    this.radioHandler.handleDisconnect(client);
    this.spacesHandler.handleDisconnect(client, fallbackUserId);
  }

  // ─── Spaces ─────────────────────────────────────────────────────────

  @SubscribeMessage('spaces:join')
  handleSpacesJoin(client: Socket, payload: { spaceId?: string }): Promise<void> {
    return this.spacesHandler.handleSpacesJoin(client, payload);
  }

  @SubscribeMessage('spaces:leave')
  handleSpacesLeave(client: Socket): Promise<void> {
    return this.spacesHandler.handleSpacesLeave(client);
  }

  @SubscribeMessage('spaces:pause')
  handleSpacesPause(client: Socket): Promise<void> {
    return this.spacesHandler.handleSpacesPause(client);
  }

  @SubscribeMessage('spaces:mute')
  handleSpacesMute(client: Socket, payload: { muted?: boolean }): Promise<void> {
    return this.spacesHandler.handleSpacesMute(client, payload);
  }

  @SubscribeMessage('spaces:lobbies:subscribe')
  handleSpacesLobbiesSubscribe(client: Socket): void {
    this.spacesHandler.handleSpacesLobbiesSubscribe(client);
  }

  @SubscribeMessage('spaces:lobbies:unsubscribe')
  handleSpacesLobbiesUnsubscribe(client: Socket): void {
    this.spacesHandler.handleSpacesLobbiesUnsubscribe(client);
  }

  @SubscribeMessage('spaces:chatSubscribe')
  handleSpacesChatSubscribe(client: Socket, payload: { spaceId?: string }): void {
    this.spacesHandler.handleSpacesChatSubscribe(client, payload);
  }

  @SubscribeMessage('spaces:chatUnsubscribe')
  handleSpacesChatUnsubscribe(client: Socket): void {
    this.spacesHandler.handleSpacesChatUnsubscribe(client);
  }

  @SubscribeMessage('spaces:chatSend')
  handleSpacesChatSend(client: Socket, payload: { spaceId?: string; body?: string; media?: unknown }): void {
    this.spacesHandler.handleSpacesChatSend(client, payload);
  }

  @SubscribeMessage('spaces:reaction')
  handleSpacesReaction(client: Socket, payload: { spaceId?: string; reactionId?: string }): void {
    this.spacesHandler.handleSpacesReaction(client, payload);
  }

  @SubscribeMessage('spaces:typing')
  handleSpacesTyping(client: Socket, payload: { spaceId?: string; typing?: boolean }): void {
    this.spacesHandler.handleSpacesTyping(client, payload);
  }

  @SubscribeMessage('spaces:announceMode')
  handleSpacesAnnounceMode(
    client: Socket,
    payload: { spaceId?: string; mode?: string; watchPartyUrl?: string | null; radioStreamUrl?: string | null },
  ): Promise<void> {
    return this.spacesHandler.handleSpacesAnnounceMode(client, payload);
  }

  @SubscribeMessage('spaces:requestWatchPartyState')
  handleRequestWatchPartyState(client: Socket, payload: { spaceId?: string }): Promise<void> {
    return this.spacesHandler.handleRequestWatchPartyState(client, payload);
  }

  @SubscribeMessage('spaces:watchPartyControl')
  handleWatchPartyControl(
    client: Socket,
    payload: { spaceId?: string; videoUrl?: string; isPlaying?: boolean; currentTime?: number; playbackRate?: number },
  ): Promise<void> {
    return this.spacesHandler.handleWatchPartyControl(client, payload);
  }

  // ─── Radio (legacy, standalone) ─────────────────────────────────────

  @SubscribeMessage('radio:join')
  handleRadioJoin(client: Socket, payload: { stationId?: string }): Promise<void> {
    return this.radioHandler.handleRadioJoin(client, payload);
  }

  @SubscribeMessage('radio:pause')
  handleRadioPause(client: Socket): Promise<void> {
    return this.radioHandler.handleRadioPause(client);
  }

  @SubscribeMessage('radio:watch')
  handleRadioWatch(client: Socket, payload: { stationId?: string }): Promise<void> {
    return this.radioHandler.handleRadioWatch(client, payload);
  }

  @SubscribeMessage('radio:leave')
  handleRadioLeave(client: Socket): Promise<void> {
    return this.radioHandler.handleRadioLeave(client);
  }

  @SubscribeMessage('radio:mute')
  handleRadioMute(client: Socket, payload: { muted?: boolean }): Promise<void> {
    return this.radioHandler.handleRadioMute(client, payload);
  }

  @SubscribeMessage('radio:lobbies:subscribe')
  handleRadioLobbiesSubscribe(client: Socket): void {
    this.radioHandler.handleRadioLobbiesSubscribe(client);
  }

  @SubscribeMessage('radio:lobbies:unsubscribe')
  handleRadioLobbiesUnsubscribe(client: Socket): void {
    this.radioHandler.handleRadioLobbiesUnsubscribe(client);
  }

  @SubscribeMessage('radio:chatSubscribe')
  handleRadioChatSubscribe(client: Socket, payload: { stationId?: string }): void {
    this.radioHandler.handleRadioChatSubscribe(client, payload);
  }

  @SubscribeMessage('radio:chatUnsubscribe')
  handleRadioChatUnsubscribe(client: Socket): void {
    this.radioHandler.handleRadioChatUnsubscribe(client);
  }

  @SubscribeMessage('radio:chatSend')
  handleRadioChatSend(client: Socket, payload: { stationId?: string; body?: string }): void {
    this.radioHandler.handleRadioChatSend(client, payload);
  }

  // ─── Presence ───────────────────────────────────────────────────────

  @SubscribeMessage('presence:subscribe')
  handleSubscribe(client: Socket, payload: { userIds?: string[] }): Promise<void> {
    return this.presenceHandler.handleSubscribe(client, payload);
  }

  @SubscribeMessage('presence:unsubscribe')
  handleUnsubscribe(client: Socket, payload: { userIds?: string[] }): void {
    this.presenceHandler.handleUnsubscribe(client, payload);
  }

  @SubscribeMessage('presence:subscribeOnlineFeed')
  handleSubscribeOnlineFeed(client: Socket): Promise<void> {
    return this.presenceHandler.handleSubscribeOnlineFeed(client);
  }

  @SubscribeMessage('presence:unsubscribeOnlineFeed')
  handleUnsubscribeOnlineFeed(client: Socket): void {
    this.presenceHandler.handleUnsubscribeOnlineFeed(client);
  }

  @SubscribeMessage('presence:logout')
  handleLogout(client: Socket): Promise<void> {
    return this.presenceHandler.handleLogout(client);
  }

  @SubscribeMessage('presence:idle')
  handleIdle(client: Socket): void {
    this.presenceHandler.handleIdle(client);
  }

  @SubscribeMessage('presence:active')
  handleActive(client: Socket): void {
    this.presenceHandler.handleActive(client);
  }

  // ─── Content subscriptions ──────────────────────────────────────────

  @SubscribeMessage('posts:subscribe')
  handlePostsSubscribe(client: Socket, payload: Partial<PostsSubscribePayloadDto>): Promise<void> {
    return this.subscriptionsHandler.handlePostsSubscribe(client, payload);
  }

  @SubscribeMessage('posts:unsubscribe')
  handlePostsUnsubscribe(client: Socket, payload: Partial<PostsSubscribePayloadDto>): void {
    this.subscriptionsHandler.handlePostsUnsubscribe(client, payload);
  }

  @SubscribeMessage('groups:subscribe')
  handleGroupsSubscribe(client: Socket, payload: Partial<GroupsSubscribePayloadDto>): Promise<void> {
    return this.subscriptionsHandler.handleGroupsSubscribe(client, payload);
  }

  @SubscribeMessage('groups:unsubscribe')
  handleGroupsUnsubscribe(client: Socket, payload: Partial<GroupsSubscribePayloadDto>): void {
    this.subscriptionsHandler.handleGroupsUnsubscribe(client, payload);
  }

  @SubscribeMessage('articles:subscribe')
  handleArticlesSubscribe(client: Socket, payload: Partial<ArticlesSubscribePayloadDto>): Promise<void> {
    return this.subscriptionsHandler.handleArticlesSubscribe(client, payload);
  }

  @SubscribeMessage('articles:unsubscribe')
  handleArticlesUnsubscribe(client: Socket, payload: Partial<ArticlesSubscribePayloadDto>): void {
    this.subscriptionsHandler.handleArticlesUnsubscribe(client, payload);
  }

  // ─── Messaging / typing ─────────────────────────────────────────────

  @SubscribeMessage('messages:screen')
  handleMessagesScreen(client: Socket, payload: { active?: boolean; conversationId?: string }): void {
    this.messagingHandler.handleMessagesScreen(client, payload);
  }

  @SubscribeMessage('messages:typing')
  handleMessagesTyping(client: Socket, payload: { conversationId?: string; typing?: boolean }): Promise<void> {
    return this.messagingHandler.handleMessagesTyping(client, payload);
  }

  @SubscribeMessage('posts:typing')
  handlePostsTyping(client: Socket, payload: { postId?: string; typing?: boolean }): void {
    this.messagingHandler.handlePostsTyping(client, payload);
  }
}
