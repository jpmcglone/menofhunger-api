export type SpaceOwnerDto = {
  id: string;
  username: string | null;
  avatarUrl: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: 'none' | 'identity' | 'manual';
};

export type SpaceDto = {
  id: string;
  title: string;
  description: string | null;
  isActive: boolean;
  mode: 'NONE' | 'WATCH_PARTY' | 'RADIO';
  watchPartyUrl: string | null;
  radioStreamUrl: string | null;
  owner: SpaceOwnerDto;
  listenerCount: number;
};

export type SpaceListenerDto = {
  id: string;
  username: string | null;
  avatarUrl: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: 'none' | 'identity' | 'manual';
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

export type SpaceChatMediaItemDto = {
  url: string;
  width: number | null;
  height: number | null;
  alt: string | null;
};

export type SpaceChatMessageDto =
  | {
      id: string;
      spaceId: string;
      kind: 'user';
      body: string;
      media?: SpaceChatMediaItemDto[];
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

export type SpaceReactionDto = {
  id: string;
  emoji: string;
  label: string;
};

export type SpaceReactionEventDto = {
  spaceId: string;
  userId: string;
  reactionId: string;
  emoji: string;
};

export type WatchPartyStateDto = {
  videoUrl: string;
  isPlaying: boolean;
  currentTime: number;
  playbackRate: number;
  updatedAt: number;
};

export type SpaceModeChangedDto = {
  spaceId: string;
  mode: 'NONE' | 'WATCH_PARTY' | 'RADIO';
  watchPartyUrl: string | null;
  radioStreamUrl: string | null;
};
