export type RadioStationDto = {
  id: string;
  name: string;
  streamUrl: string;
  attributionName: string | null;
  attributionUrl: string | null;
};

export type RadioListenerDto = {
  id: string;
  username: string | null;
  avatarUrl: string | null;
  paused?: boolean;
  muted?: boolean;
};

/**
 * Realtime lobby counts for all configured stations.
 * Keys are station IDs (e.g. "groovesalad"); values are the number of users currently in that station's lobby.
 */
export type RadioLobbyCountsDto = {
  countsByStationId: Record<string, number>;
};

export type RadioChatSenderDto = {
  id: string;
  username: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: 'none' | 'identity' | 'manual';
  stewardBadgeEnabled: boolean;
};

export type RadioChatMessageDto = {
  id: string;
  stationId: string;
  body: string;
  createdAt: string; // ISO
  sender: RadioChatSenderDto;
};

export type RadioChatSnapshotDto = {
  stationId: string;
  messages: RadioChatMessageDto[];
};

