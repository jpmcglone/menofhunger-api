import { Injectable } from '@nestjs/common';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationPushService } from './notification-push.service';
import { ApnsPushService } from './apns-push.service';
import { NotificationReadStateService } from './notification-read-state.service';
import { NotificationQueryService } from './notification-query.service';
import { NotificationWriterService } from './notification-writer.service';

export type { NotificationUnreadByKind } from './notification-read-state.service';
export type { CreateNotificationParams } from './notification-writer.service';

/**
 * Facade over the notifications domain. Other modules depend on this stable
 * surface; the actual logic lives in focused sub-services:
 *
 *   - NotificationWriterService      — create + upsert/delete row families + fan-out
 *   - NotificationQueryService       — bell list, new-posts feed, DTO composition
 *   - NotificationReadStateService   — badge counts, mark read/delivered flows
 *   - NotificationPushService        — Web Push delivery + subscription management
 *   - NotificationPreferencesService — per-user notification preferences
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly preferences: NotificationPreferencesService,
    private readonly push: NotificationPushService,
    private readonly apnsPush: ApnsPushService,
    private readonly readState: NotificationReadStateService,
    private readonly query: NotificationQueryService,
    private readonly writer: NotificationWriterService,
  ) {}

  // ── Writes ─────────────────────────────────────────────────────────────────

  create(...args: Parameters<NotificationWriterService['create']>) {
    return this.writer.create(...args);
  }

  hasRecentFollowNotification(...args: Parameters<NotificationWriterService['hasRecentFollowNotification']>) {
    return this.writer.hasRecentFollowNotification(...args);
  }

  findExistingBoostNotification(...args: Parameters<NotificationWriterService['findExistingBoostNotification']>) {
    return this.writer.findExistingBoostNotification(...args);
  }

  upsertBoostNotification(...args: Parameters<NotificationWriterService['upsertBoostNotification']>) {
    return this.writer.upsertBoostNotification(...args);
  }

  deleteBoostNotification(...args: Parameters<NotificationWriterService['deleteBoostNotification']>) {
    return this.writer.deleteBoostNotification(...args);
  }

  upsertRepostNotification(...args: Parameters<NotificationWriterService['upsertRepostNotification']>) {
    return this.writer.upsertRepostNotification(...args);
  }

  deleteRepostNotification(...args: Parameters<NotificationWriterService['deleteRepostNotification']>) {
    return this.writer.deleteRepostNotification(...args);
  }

  deleteBySubjectPostId(...args: Parameters<NotificationWriterService['deleteBySubjectPostId']>) {
    return this.writer.deleteBySubjectPostId(...args);
  }

  deleteByActorPostId(...args: Parameters<NotificationWriterService['deleteByActorPostId']>) {
    return this.writer.deleteByActorPostId(...args);
  }

  deleteCrewJoinedNotificationsForActor(...args: Parameters<NotificationWriterService['deleteCrewJoinedNotificationsForActor']>) {
    return this.writer.deleteCrewJoinedNotificationsForActor(...args);
  }

  deleteFollowNotification(...args: Parameters<NotificationWriterService['deleteFollowNotification']>) {
    return this.writer.deleteFollowNotification(...args);
  }

  upsertCommunityGroupInviteReceivedNotification(
    ...args: Parameters<NotificationWriterService['upsertCommunityGroupInviteReceivedNotification']>
  ) {
    return this.writer.upsertCommunityGroupInviteReceivedNotification(...args);
  }

  upsertCommunityGroupInviteResponseNotification(
    ...args: Parameters<NotificationWriterService['upsertCommunityGroupInviteResponseNotification']>
  ) {
    return this.writer.upsertCommunityGroupInviteResponseNotification(...args);
  }

  upsertGroupMemberJoinedNotification(...args: Parameters<NotificationWriterService['upsertGroupMemberJoinedNotification']>) {
    return this.writer.upsertGroupMemberJoinedNotification(...args);
  }

  upsertGroupJoinDecisionNotification(...args: Parameters<NotificationWriterService['upsertGroupJoinDecisionNotification']>) {
    return this.writer.upsertGroupJoinDecisionNotification(...args);
  }

  upsertGroupMemberRemovedNotification(...args: Parameters<NotificationWriterService['upsertGroupMemberRemovedNotification']>) {
    return this.writer.upsertGroupMemberRemovedNotification(...args);
  }

  upsertGroupDisbandedNotification(...args: Parameters<NotificationWriterService['upsertGroupDisbandedNotification']>) {
    return this.writer.upsertGroupDisbandedNotification(...args);
  }

  upsertCrewMemberLeftNotification(...args: Parameters<NotificationWriterService['upsertCrewMemberLeftNotification']>) {
    return this.writer.upsertCrewMemberLeftNotification(...args);
  }

  upsertCrewMemberKickedNotification(...args: Parameters<NotificationWriterService['upsertCrewMemberKickedNotification']>) {
    return this.writer.upsertCrewMemberKickedNotification(...args);
  }

  upsertCrewDisbandedNotification(...args: Parameters<NotificationWriterService['upsertCrewDisbandedNotification']>) {
    return this.writer.upsertCrewDisbandedNotification(...args);
  }

  upsertMarvNotInGroupNotification(...args: Parameters<NotificationWriterService['upsertMarvNotInGroupNotification']>) {
    return this.writer.upsertMarvNotInGroupNotification(...args);
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  list(...args: Parameters<NotificationQueryService['list']>) {
    return this.query.list(...args);
  }

  listNewPostsFeed(...args: Parameters<NotificationQueryService['listNewPostsFeed']>) {
    return this.query.listNewPostsFeed(...args);
  }

  // ── Read state / badges ────────────────────────────────────────────────────

  getUndeliveredCount(...args: Parameters<NotificationReadStateService['getUndeliveredCount']>) {
    return this.readState.getUndeliveredCount(...args);
  }

  getUnreadCountsByKind(...args: Parameters<NotificationReadStateService['getUnreadCountsByKind']>) {
    return this.readState.getUnreadCountsByKind(...args);
  }

  getUnreadCommentCount(...args: Parameters<NotificationReadStateService['getUnreadCommentCount']>) {
    return this.readState.getUnreadCommentCount(...args);
  }

  markDelivered(...args: Parameters<NotificationReadStateService['markDelivered']>) {
    return this.readState.markDelivered(...args);
  }

  markNewPostsRead(...args: Parameters<NotificationReadStateService['markNewPostsRead']>) {
    return this.readState.markNewPostsRead(...args);
  }

  markReadBySubject(...args: Parameters<NotificationReadStateService['markReadBySubject']>) {
    return this.readState.markReadBySubject(...args);
  }

  markCrewInviteResolved(...args: Parameters<NotificationReadStateService['markCrewInviteResolved']>) {
    return this.readState.markCrewInviteResolved(...args);
  }

  markReadById(...args: Parameters<NotificationReadStateService['markReadById']>) {
    return this.readState.markReadById(...args);
  }

  ignoreById(...args: Parameters<NotificationReadStateService['ignoreById']>) {
    return this.readState.ignoreById(...args);
  }

  markNudgesReadByActor(...args: Parameters<NotificationReadStateService['markNudgesReadByActor']>) {
    return this.readState.markNudgesReadByActor(...args);
  }

  markNudgesNudgedBackByActor(...args: Parameters<NotificationReadStateService['markNudgesNudgedBackByActor']>) {
    return this.readState.markNudgesNudgedBackByActor(...args);
  }

  markNudgeNudgedBackById(...args: Parameters<NotificationReadStateService['markNudgeNudgedBackById']>) {
    return this.readState.markNudgeNudgedBackById(...args);
  }

  ignoreNudgesByActor(...args: Parameters<NotificationReadStateService['ignoreNudgesByActor']>) {
    return this.readState.ignoreNudgesByActor(...args);
  }

  markAllRead(...args: Parameters<NotificationReadStateService['markAllRead']>) {
    return this.readState.markAllRead(...args);
  }

  markConversationMessageNotificationRead(
    ...args: Parameters<NotificationReadStateService['markConversationMessageNotificationRead']>
  ) {
    return this.readState.markConversationMessageNotificationRead(...args);
  }

  getGroupsUnread(...args: Parameters<NotificationReadStateService['getGroupsUnread']>) {
    return this.readState.getGroupsUnread(...args);
  }

  markGroupPostsDelivered(...args: Parameters<NotificationReadStateService['markGroupPostsDelivered']>) {
    return this.readState.markGroupPostsDelivered(...args);
  }

  createGroupPostBadgeNotifications(...args: Parameters<NotificationWriterService['createGroupPostBadgeNotifications']>) {
    return this.writer.createGroupPostBadgeNotifications(...args);
  }

  // ── Preferences ────────────────────────────────────────────────────────────

  getPreferences(...args: Parameters<NotificationPreferencesService['getPreferences']>) {
    return this.preferences.getPreferences(...args);
  }

  updatePreferences(...args: Parameters<NotificationPreferencesService['updatePreferences']>) {
    return this.preferences.updatePreferences(...args);
  }

  // ── Push ───────────────────────────────────────────────────────────────────

  pushSubscribe(...args: Parameters<NotificationPushService['pushSubscribe']>) {
    return this.push.pushSubscribe(...args);
  }

  pushUnsubscribe(...args: Parameters<NotificationPushService['pushUnsubscribe']>) {
    return this.push.pushUnsubscribe(...args);
  }

  apnsRegister(...args: Parameters<ApnsPushService['registerToken']>) {
    return this.apnsPush.registerToken(...args);
  }

  apnsUnregister(...args: Parameters<ApnsPushService['unregisterToken']>) {
    return this.apnsPush.unregisterToken(...args);
  }

  sendTestPush(...args: Parameters<NotificationPushService['sendTestPush']>) {
    return this.push.sendTestPush(...args);
  }

  sendReplyNudgePush(...args: Parameters<NotificationPushService['sendReplyNudgePush']>) {
    return this.push.sendReplyNudgePush(...args);
  }

  sendStreakReminderPush(...args: Parameters<NotificationPushService['sendStreakReminderPush']>) {
    return this.push.sendStreakReminderPush(...args);
  }

  sendCrewStreakAdvancedPush(...args: Parameters<NotificationPushService['sendCrewStreakAdvancedPush']>) {
    return this.push.sendCrewStreakAdvancedPush(...args);
  }

  sendCrewStreakBrokenPush(...args: Parameters<NotificationPushService['sendCrewStreakBrokenPush']>) {
    return this.push.sendCrewStreakBrokenPush(...args);
  }

  sendMessagePush(...args: Parameters<NotificationPushService['sendMessagePush']>) {
    return this.push.sendMessagePush(...args);
  }
}
