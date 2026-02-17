export type NotificationPreferencesDto = {
  pushComment: boolean;
  pushBoost: boolean;
  pushFollow: boolean;
  pushMention: boolean;
  pushMessage: boolean;
  emailDigestDaily: boolean;
  emailNewNotifications: boolean;
  /** Optional: near-immediate emails for high-signal events (messages + mentions/replies). */
  emailInstantHighSignal: boolean;
};

