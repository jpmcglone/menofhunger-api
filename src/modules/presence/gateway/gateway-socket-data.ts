import type { RadioChatSenderDto, SpaceChatSenderDto } from '../../../common/dto';

/** Visibility fields the gateway derives from the session on connect and reuses for room access checks. */
export type GatewayViewer = {
  verified: boolean;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: 'none' | 'identity' | 'manual';
  siteAdmin: boolean;
};

/** Everything the gateway stores on `socket.data`. Fields are populated by the connection handler. */
export type GatewaySocketData = {
  userId?: string;
  anonId?: string;
  presenceClient?: string;
  impersonated?: boolean;
  viewer?: GatewayViewer;
  radioChatUser?: RadioChatSenderDto;
  spaceChatUser?: SpaceChatSenderDto;
  radioChatStationId?: string | null;
  spaceChatSpaceId?: string | null;
  ownerSpaceId?: string | null;
  postSubs?: Set<string>;
  groupSubs?: Set<string>;
  articleSubs?: Set<string>;
  /** Resolves when async connection setup (auth, viewer) is done. */
  __ready?: Promise<void>;
};

/** Typed view of `socket.data` (socket.io types it `any`). */
export function socketData(socket: { data: unknown }): GatewaySocketData {
  return socket.data as GatewaySocketData;
}

/** Array of strings under `key` in a loosely typed client payload; anything else yields `[]`. */
export function payloadIdList(payload: unknown, key: string): unknown[] {
  const value = (payload as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(value) ? value : [];
}
