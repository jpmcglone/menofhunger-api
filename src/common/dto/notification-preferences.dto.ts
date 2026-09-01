export type NotificationPreferencesDto = {
  pushComment: boolean;
  pushBoost: boolean;
  pushFollow: boolean;
  pushMention: boolean;
  pushMessage: boolean;
  pushRepost: boolean;
  pushNudge: boolean;
  pushFollowedPost: boolean;
  /** Send a single push 24h after a reply if the recipient hasn't opened it yet. Once-per-notification, never spammed. */
  pushReplyNudge: boolean;
  /** Crew streak: push when the strict crew streak advances or breaks. Highest-signal push in the product. */
  pushCrewStreak: boolean;
  /** Group activity: push for join, approve/reject, remove, disband events. */
  pushGroupActivity: boolean;
  /** Word of the day + quote of the day push (fires at 9:00am / 9:30am ET). */
  pushDailyContent: boolean;
  /** 6pm ET reminder to complete today's check-in (skipped if user already checked in). */
  pushCheckinReminder: boolean;
  emailDigestWeekly: boolean;
  emailNewNotifications: boolean;
  /** Optional: near-immediate emails for high-signal events (messages + mentions/replies). */
  emailInstantHighSignal: boolean;
  /** Evening reminder email when the user's check-in streak is at risk. */
  emailStreakReminder: boolean;
  /** Send an email when someone you follow publishes a new article. */
  emailFollowedArticle: boolean;
  /** Admin-authored lodge newsletter. On by default. */
  emailNewsletter: boolean;
};

