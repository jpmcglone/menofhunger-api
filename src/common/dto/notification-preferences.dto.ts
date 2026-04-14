export type NotificationPreferencesDto = {
  pushComment: boolean;
  pushBoost: boolean;
  pushFollow: boolean;
  pushMention: boolean;
  pushMessage: boolean;
  pushRepost: boolean;
  pushNudge: boolean;
  pushFollowedPost: boolean;
  emailDigestDaily: boolean;
  emailDigestWeekly: boolean;
  emailNewNotifications: boolean;
  /** Optional: near-immediate emails for high-signal events (messages + mentions/replies). */
  emailInstantHighSignal: boolean;
  /** Send an email when someone you follow publishes a new article. */
  emailFollowedArticle: boolean;
};

