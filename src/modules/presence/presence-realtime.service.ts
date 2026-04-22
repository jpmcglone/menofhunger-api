import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { PresenceService } from './presence.service';
import { PresenceRedisStateService } from './presence-redis-state.service';
import { WsEventNames } from '../../common/dto';
import type {
  AdminUpdatedPayloadDto,
  ArticlesLiveUpdatedPayloadDto,
  ArticlesCommentAddedPayloadDto,
  ArticlesCommentDeletedPayloadDto,
  ArticlesCommentUpdatedPayloadDto,
  ArticlesCommentReactionChangedPayloadDto,
  FeedNewPostPayloadDto,
  FollowsChangedPayloadDto,
  MessagesReadPayloadDto,
  PostsLiveUpdatedPayloadDto,
  PostsCommentAddedPayloadDto,
  PostsCommentDeletedPayloadDto,
  UsersMeUpdatedPayloadDto,
  NotificationsDeletedPayloadDto,
  NotificationsNewPayloadDto,
  PostsInteractionPayloadDto,
  UsersSelfUpdatedPayloadDto,
} from '../../common/dto';

@Injectable()
export class PresenceRealtimeService {
  private readonly logger = new Logger(PresenceRealtimeService.name);
  private server: Server | null = null;

  constructor(
    private readonly presence: PresenceService,
    private readonly presenceRedis: PresenceRedisStateService,
  ) {}

  /**
   * Called by PresenceGateway once Socket.IO is initialized.
   * Safe to call multiple times (e.g. dev HMR/restart).
   */
  setServer(server: Server): void {
    this.server = server;
  }

  private getServerOrNull(): Server | null {
    if (this.server) return this.server;
    // This can happen during startup or tests; do not crash background work.
    this.logger.debug('[presence] Socket server not initialized; dropping realtime emit.');
    return null;
  }

  private emitToUser(userId: string, event: string, payload: unknown): void {
    const server = this.getServerOrNull();
    if (!server) return;
    const uid = (userId ?? '').trim();
    const ev = (event ?? '').trim();
    if (!uid || !ev) return;

    // Local delivery (fast path).
    this.presence.emitToUser(server, uid, ev, payload);
    // Cross-instance delivery (best-effort).
    void this.presenceRedis.publishEmitToUser({ userId: uid, event: ev, payload }).catch(() => undefined);
  }

  private emitToUsers(userIds: Iterable<string>, event: string, payload: unknown): void {
    for (const userId of userIds) {
      if (!userId) continue;
      this.emitToUser(userId, event, payload);
    }
  }

  private emitToRoom(room: string, event: string, payload: unknown): void {
    const server = this.getServerOrNull();
    if (!server) return;
    const r = (room ?? '').trim();
    const ev = (event ?? '').trim();
    if (!r || !ev) return;
    server.to(r).emit(ev, payload);
    void this.presenceRedis.publishEmitToRoom({ room: r, event: ev, payload }).catch(() => undefined);
  }

  disconnectUserSockets(userId: string): void {
    const server = this.getServerOrNull();
    if (!server) return;
    const ids = this.presence.getSocketIdsForUser(userId);
    for (const id of ids) {
      try {
        server.sockets.sockets.get(id)?.disconnect(true);
      } catch {
        // ignore
      }
    }
  }

  emitNotificationsUpdated(userId: string, payload: { undeliveredCount: number }): void {
    this.emitToUser(userId, 'notifications:updated', payload);
  }

  emitNotificationNew(userId: string, payload: NotificationsNewPayloadDto): void {
    this.emitToUser(userId, 'notifications:new', payload);
  }

  emitNotificationsDeleted(userId: string, payload: NotificationsDeletedPayloadDto): void {
    this.emitToUser(userId, 'notifications:deleted', payload);
  }

  emitMessagesUpdated(userId: string, payload: { primaryUnreadCount: number; requestUnreadCount: number }): void {
    this.emitToUser(userId, 'messages:updated', payload);
  }

  emitMessagesRead(userId: string, payload: MessagesReadPayloadDto): void {
    this.emitToUser(userId, 'messages:read', payload);
  }

  emitMessageCreated(userId: string, payload: { conversationId: string; message: unknown }): void {
    this.emitToUser(userId, 'messages:new', payload);
  }

  emitMessageReactionUpdated(userId: string, payload: { conversationId: string; message: unknown }): void {
    this.emitToUser(userId, 'messages:reaction', payload);
  }

  emitMessageEdited(userId: string, payload: { conversationId: string; message: unknown }): void {
    this.emitToUser(userId, 'messages:edited', payload);
  }

  emitMessageDeletedForAll(userId: string, payload: { conversationId: string; messageId: string }): void {
    this.emitToUser(userId, 'messages:deleted-for-all', payload);
  }

  emitFollowsChanged(userId: string, payload: FollowsChangedPayloadDto): void {
    this.emitToUser(userId, 'follows:changed', payload);
  }

  emitPostsInteraction(userIds: Iterable<string>, payload: PostsInteractionPayloadDto): void {
    this.emitToUsers(userIds, 'posts:interaction', payload);
  }

  emitAdminUpdated(userId: string, payload: AdminUpdatedPayloadDto): void {
    this.emitToUser(userId, 'admin:updated', payload);
  }

  emitUsersSelfUpdated(userIds: Iterable<string>, payload: UsersSelfUpdatedPayloadDto): void {
    this.emitToUsers(userIds, WsEventNames.usersSelfUpdated, payload);
  }

  /** Self-only auth/settings updates (never broadcast beyond the user's sockets). */
  emitUsersMeUpdated(userId: string, payload: UsersMeUpdatedPayloadDto): void {
    this.emitToUser(userId, WsEventNames.usersMeUpdated, payload);
  }

  /** Scoped post live updates (delivered only to sockets subscribed to this post). */
  emitPostsLiveUpdated(postId: string, payload: PostsLiveUpdatedPayloadDto): void {
    const pid = (postId ?? '').trim();
    if (!pid) return;
    this.emitToRoom(`post:${pid}`, WsEventNames.postsLiveUpdated, payload);
  }

  /** Full reply DTO pushed to post room subscribers when a new reply is created. */
  emitPostsCommentAdded(parentPostId: string, payload: PostsCommentAddedPayloadDto): void {
    const pid = (parentPostId ?? '').trim();
    if (!pid) return;
    this.emitToRoom(`post:${pid}`, WsEventNames.postsCommentAdded, payload);
  }

  /**
   * New top-level post from someone the viewer follows.
   * Pushed directly to each eligible follower's `user:{followerId}` room.
   * Callers should already have filtered for visibility and self-exclusion.
   */
  emitFeedNewPost(followerIds: Iterable<string>, payload: FeedNewPostPayloadDto): void {
    this.emitToUsers(followerIds, WsEventNames.feedNewPost, payload);
  }

  /** Delete hint pushed to post room subscribers when a reply is soft-deleted. */
  emitPostsCommentDeleted(parentPostId: string, payload: PostsCommentDeletedPayloadDto): void {
    const pid = (parentPostId ?? '').trim();
    if (!pid) return;
    this.emitToRoom(`post:${pid}`, WsEventNames.postsCommentDeleted, payload);
  }

  /** Scoped article live updates (delivered only to sockets subscribed to this article). */
  emitArticlesLiveUpdated(articleId: string, payload: ArticlesLiveUpdatedPayloadDto): void {
    const aid = (articleId ?? '').trim();
    if (!aid) return;
    this.emitToRoom(`article:${aid}`, WsEventNames.articlesLiveUpdated, payload);
  }

  emitArticlesCommentAdded(articleId: string, payload: ArticlesCommentAddedPayloadDto): void {
    const aid = (articleId ?? '').trim();
    if (!aid) return;
    this.emitToRoom(`article:${aid}`, WsEventNames.articlesCommentAdded, payload);
  }

  emitArticlesCommentDeleted(articleId: string, payload: ArticlesCommentDeletedPayloadDto): void {
    const aid = (articleId ?? '').trim();
    if (!aid) return;
    this.emitToRoom(`article:${aid}`, WsEventNames.articlesCommentDeleted, payload);
  }

  emitArticlesCommentUpdated(articleId: string, payload: ArticlesCommentUpdatedPayloadDto): void {
    const aid = (articleId ?? '').trim();
    if (!aid) return;
    this.emitToRoom(`article:${aid}`, WsEventNames.articlesCommentUpdated, payload);
  }

  emitArticlesCommentReactionChanged(articleId: string, payload: ArticlesCommentReactionChangedPayloadDto): void {
    const aid = (articleId ?? '').trim();
    if (!aid) return;
    this.emitToRoom(`article:${aid}`, WsEventNames.articlesCommentReactionChanged, payload);
  }

  /**
   * Crew realtime: we fan out events to each crew member's sockets directly (no rooms),
   * mirroring the approach used for direct-message conversations. Rooms would require an
   * explicit subscribe handshake; per-user emits match existing notification behavior and
   * survive reconnects.
   */
  emitCrewUpdated(userIds: Iterable<string>, payload: { crew: unknown }): void {
    this.emitToUsers(userIds, 'crew:updated', payload);
  }

  emitCrewMembersChanged(userIds: Iterable<string>, payload: { crewId: string; kind: 'joined' | 'left' | 'kicked'; userId: string }): void {
    this.emitToUsers(userIds, 'crew:members-changed', payload);
  }

  emitCrewOwnerChanged(userIds: Iterable<string>, payload: { crewId: string; newOwnerUserId: string; previousOwnerUserId: string; reason: 'direct' | 'vote' | 'inactivity' }): void {
    this.emitToUsers(userIds, 'crew:owner-changed', payload);
  }

  emitCrewDisbanded(userIds: Iterable<string>, payload: { crewId: string }): void {
    this.emitToUsers(userIds, 'crew:disbanded', payload);
  }

  emitCrewInviteReceived(userId: string, payload: { invite: unknown }): void {
    this.emitToUser(userId, 'crew:invite-received', payload);
  }

  emitCrewInviteUpdated(userIds: Iterable<string>, payload: { invite: unknown }): void {
    this.emitToUsers(userIds, 'crew:invite-updated', payload);
  }

  emitGroupInviteReceived(userId: string, payload: { invite: unknown }): void {
    this.emitToUser(userId, 'groups:invite-received', payload);
  }

  emitGroupInviteUpdated(userIds: Iterable<string>, payload: { invite: unknown }): void {
    this.emitToUsers(userIds, 'groups:invite-updated', payload);
  }

  emitCrewWallMessage(userIds: Iterable<string>, payload: { crewId: string; conversationId: string; message: unknown }): void {
    this.emitToUsers(userIds, 'crew:wall:new', payload);
  }

  emitCrewWallMessageEdited(userIds: Iterable<string>, payload: { crewId: string; conversationId: string; message: unknown }): void {
    this.emitToUsers(userIds, 'crew:wall:edited', payload);
  }

  emitCrewWallMessageDeleted(userIds: Iterable<string>, payload: { crewId: string; conversationId: string; messageId: string }): void {
    this.emitToUsers(userIds, 'crew:wall:deleted', payload);
  }

  emitCrewWallReaction(userIds: Iterable<string>, payload: { crewId: string; conversationId: string; message: unknown }): void {
    this.emitToUsers(userIds, 'crew:wall:reaction', payload);
  }

  emitCrewTransferVote(userIds: Iterable<string>, payload: { crewId: string; vote: unknown }): void {
    this.emitToUsers(userIds, 'crew:transfer-vote', payload);
  }
}

