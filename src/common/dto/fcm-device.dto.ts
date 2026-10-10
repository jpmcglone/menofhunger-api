/** App-generated installation UUID; never a user or session identifier. */
export type FcmRegisterRequestDto = {
  installationId: string;
  token: string;
  notificationsEnabled: boolean;
};

/** Server-owned binding. Persist before accepting messages for this installation. */
export type FcmRegistrationDto = { bindingId: string };

export type FcmUnregisterRequestDto = {
  installationId: string;
  bindingId: string;
};

/** FCM data-only messages contain strings and never contain authored/private content. */
export type FcmPushPayloadDto = {
  schemaVersion: "1";
  bindingId: string;
  recipientUserId: string;
  eventId: string;
  kind: string;
  /** Same-site relative path. Clients resolve it through their authenticated router. */
  destination: string;
  /** ISO timestamp. Expired, wrong-account, or wrong-binding messages must be discarded. */
  expiresAt: string;
  tag: string;
  title: string;
  body: string;
};
