export type SpaceStationDto = {
  id: string;
  name: string;
  streamUrl: string;
  attributionName: string | null;
  attributionUrl: string | null;
};

export type SpaceDto = {
  id: string;
  name: string;
  /**
   * Optional attached music station. When null, the space still exists but has no music playback.
   */
  stationId: string | null;
  station: SpaceStationDto | null;
  /**
   * Built-in = shipped by the app (seeded). Non-built-in is reserved for future user-created spaces.
   */
  isBuiltin: boolean;
};

export type SpaceListenerDto = {
  id: string;
  username: string | null;
  avatarUrl: string | null;
  paused?: boolean;
  muted?: boolean;
};

export type SpaceLobbyCountsDto = {
  countsBySpaceId: Record<string, number>;
};

export type SpaceChatSenderDto = {
  id: string;
  username: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: 'none' | 'identity' | 'manual';
  stewardBadgeEnabled: boolean;
};

export type SpaceChatMessageDto =
  | {
      id: string;
      spaceId: string;
      kind: 'user';
      body: string;
      createdAt: string; // ISO
      sender: SpaceChatSenderDto;
    }
  | {
      id: string;
      spaceId: string;
      kind: 'system';
      system: {
        firstEvent: 'join' | 'leave';
        lastEvent: 'join' | 'leave';
        userId: string;
        username: string | null;
      };
      body: string;
      createdAt: string; // ISO
      sender: null;
    };

export type SpaceChatSnapshotDto = {
  spaceId: string;
  messages: SpaceChatMessageDto[];
};

