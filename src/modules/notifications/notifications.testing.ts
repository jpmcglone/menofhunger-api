import { NotificationNudgesService } from "./notification-nudges.service";
import { NotificationReadSubjectsService } from "./notification-read-subjects.service";
import { NotificationPreferencesService } from "./notification-preferences.service";
import { NotificationPushService } from "./notification-push.service";
import { ApnsPushService } from "./apns-push.service";
import { NotificationReadStateService } from "./notification-read-state.service";
import { NotificationQueryService } from "./notification-query.service";
import { NotificationInviteWriterService } from "./notification-invite-writer.service";
import { NotificationWriterCommunityService } from "./notification-writer-community.service";
import { NotificationWriterFanoutService } from "./notification-writer-fanout.service";
import { makeNotificationWriter } from "./notification-writer.testing";

export type { NotificationUnreadByKind } from "./notification-read-state.service";
export type { CreateNotificationParams } from "./notification-writer.constants";

/** Test-only composition preserving the existing domain behavior fixtures. */
export function makeNotificationsTestApi(
  preferences: NotificationPreferencesService,
  push: NotificationPushService,
  apnsPush: ApnsPushService,
  readState: NotificationReadStateService,
  query: NotificationQueryService,
  writer: ReturnType<typeof makeNotificationWriter>,
  community: NotificationWriterCommunityService,
  invites: NotificationInviteWriterService,
  fanout: NotificationWriterFanoutService,
  nudges: NotificationNudgesService,
  readSubjects: NotificationReadSubjectsService,
) {
  return {
    fanout,
    query,
    create: writer.create.bind(writer),
    hasRecentFollowNotification:
      writer.hasRecentFollowNotification.bind(writer),
    findExistingBoostNotification:
      writer.findExistingBoostNotification.bind(writer),
    upsertBoostNotification: writer.upsertBoostNotification.bind(writer),
    deleteBoostNotification: writer.deleteBoostNotification.bind(writer),
    deleteArticleBoostNotification:
      writer.deleteArticleBoostNotification.bind(writer),
    upsertRepostNotification: writer.upsertRepostNotification.bind(writer),
    deleteRepostNotification: writer.deleteRepostNotification.bind(writer),
    deleteBySubjectPostId: writer.deleteBySubjectPostId.bind(writer),
    deleteByActorPostId: writer.deleteByActorPostId.bind(writer),
    deleteCrewJoinedNotificationsForActor:
      writer.deleteCrewJoinedNotificationsForActor.bind(writer),
    deleteFollowNotification: writer.deleteFollowNotification.bind(writer),
    upsertCommunityGroupInviteReceivedNotification:
      invites.upsertCommunityGroupInviteReceivedNotification.bind(invites),
    upsertCommunityGroupInviteResponseNotification:
      invites.upsertCommunityGroupInviteResponseNotification.bind(invites),
    upsertGroupMemberJoinedNotification:
      community.upsertGroupMemberJoinedNotification.bind(community),
    upsertGroupJoinDecisionNotification:
      community.upsertGroupJoinDecisionNotification.bind(community),
    upsertGroupMemberRemovedNotification:
      community.upsertGroupMemberRemovedNotification.bind(community),
    upsertGroupDisbandedNotification:
      community.upsertGroupDisbandedNotification.bind(community),
    upsertCrewMemberLeftNotification:
      community.upsertCrewMemberLeftNotification.bind(community),
    upsertCrewMemberKickedNotification:
      community.upsertCrewMemberKickedNotification.bind(community),
    upsertCrewDisbandedNotification:
      community.upsertCrewDisbandedNotification.bind(community),
    upsertMarvNotInGroupNotification:
      writer.upsertMarvNotInGroupNotification.bind(writer),
    upsertSpaceScheduleNotification:
      fanout.upsertSpaceScheduleNotification.bind(fanout),
    listRecipientIdsForSpaceNotification:
      fanout.listRecipientIdsForSpaceNotification.bind(fanout),
    fanOutStatusUpdateNotifications:
      fanout.fanOutStatusUpdateNotifications.bind(fanout),
    list: query.list.bind(query),
    listNewPostsFeed: query.listNewPostsFeed.bind(query),
    getUndeliveredCount: readState.getUndeliveredCount.bind(readState),
    getUnreadCountsByKind: readState.getUnreadCountsByKind.bind(readState),
    getUnreadCommentCount: readState.getUnreadCommentCount.bind(readState),
    getNavUnread: readState.getNavUnread.bind(readState),
    markDelivered: readState.markDelivered.bind(readState),
    clearLockScreen: readState.dispatchLockScreenClear.bind(readState),
    markNewPostsRead: readState.markNewPostsRead.bind(readState),
    markReadBySubject: readSubjects.markReadBySubject.bind(readSubjects),
    markReadByFilter: readState.markReadByFilter.bind(readState),
    markReadBySubjects: readSubjects.markReadBySubjects.bind(readSubjects),
    markCrewInviteResolved: readState.markCrewInviteResolved.bind(readState),
    markReadById: readState.markReadById.bind(readState),
    ignoreById: readState.ignoreById.bind(readState),
    markNudgesReadByActor: nudges.markNudgesReadByActor.bind(nudges),
    markNudgesNudgedBackByActor:
      nudges.markNudgesNudgedBackByActor.bind(nudges),
    markNudgeNudgedBackById: nudges.markNudgeNudgedBackById.bind(nudges),
    ignoreNudgesByActor: nudges.ignoreNudgesByActor.bind(nudges),
    markAllRead: readState.markAllRead.bind(readState),
    markReadByKind: readState.markReadByKind.bind(readState),
    markConversationMessageNotificationRead:
      readState.markConversationMessageNotificationRead.bind(readState),
    getGroupsUnread: readState.getGroupsUnread.bind(readState),
    markGroupPostsDelivered: readState.markGroupPostsDelivered.bind(readState),
    createGroupPostBadgeNotifications:
      invites.createGroupPostBadgeNotifications.bind(invites),
    getPreferences: preferences.getPreferences.bind(preferences),
    updatePreferences: preferences.updatePreferences.bind(preferences),
    pushSubscribe: push.pushSubscribe.bind(push),
    pushUnsubscribe: push.pushUnsubscribe.bind(push),
    apnsRegister: apnsPush.registerToken.bind(apnsPush),
    apnsUnregister: apnsPush.unregisterToken.bind(apnsPush),
    sendTestPush: push.sendTestPush.bind(push),
    sendReplyNudgePush: push.sendReplyNudgePush.bind(push),
    sendCrewStreakAdvancedPush: push.sendCrewStreakAdvancedPush.bind(push),
    sendCrewStreakBrokenPush: push.sendCrewStreakBrokenPush.bind(push),
    sendMessagePush: push.sendMessagePush.bind(push),
    upsertPremiumStatusNotification:
      fanout.upsertPremiumStatusNotification.bind(fanout),
  };
}
