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
  /** ISO upcoming go-live time, or null when unscheduled. */
  scheduledAt: string | null;
  mode: 'NONE' | 'WATCH_PARTY' | 'RADIO';
  watchPartyUrl: string | null;
  radioStreamUrl: string | null;
  /** YouTube OG title or radio station name when something is on; null when idle/unknown. */
  playbackTitle: string | null;
  owner: SpaceOwnerDto;
  listenerCount: number;
  /** Whether the authenticated viewer is subscribed to schedule reminders. */
  viewerSubscribed: boolean;
  /** Count of Notify-me subscribers excluding the host (host is always reminded). */
  subscriberCount: number;
  /** Whether the authenticated viewer follows this space's owner. */
  viewerFollowsOwner: boolean;
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

/**
 * Shared (viewer-agnostic) space fields for live lobby/host UI.
 * Do NOT include viewerSubscribed / viewerFollowsOwner — those are per-viewer.
 */
export type SpacesUpdatedPatchDto = Partial<{
  title: string;
  description: string | null;
  isActive: boolean;
  scheduledAt: string | null;
  mode: 'NONE' | 'WATCH_PARTY' | 'RADIO';
  watchPartyUrl: string | null;
  radioStreamUrl: string | null;
  playbackTitle: string | null;
  /** Notify-me signups excluding the host. */
  subscriberCount: number;
  /** Space row removed — clients should drop from lobby lists. */
  deleted: boolean;
}>;

/** Broadcast to `spaces:lobbies` when schedule / notify signup / live state changes. */
export type SpacesUpdatedPayloadDto = {
  spaceId: string;
  version: string;
  reason: string;
  patch: SpacesUpdatedPatchDto;
};

export type SpaceChatSenderDto = {
  id: string;
  username: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  verifiedStatus: 'none' | 'identity' | 'manual';
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
      /** Parent id only. Clients resolve a snippet locally if they have that message. */
      replyToId?: string | null;
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

/** Live-only. Clients without the target message drop it. */
export type SpaceChatReactionEventDto = {
  spaceId: string;
  messageId: string;
  userId: string;
  username: string | null;
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
