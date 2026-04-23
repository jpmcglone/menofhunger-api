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
  emailDigestDaily: boolean;
  emailDigestWeekly: boolean;
  emailNewNotifications: boolean;
  /** Optional: near-immediate emails for high-signal events (messages + mentions/replies). */
  emailInstantHighSignal: boolean;
  /** Send an email when someone you follow publishes a new article. */
  emailFollowedArticle: boolean;
};

