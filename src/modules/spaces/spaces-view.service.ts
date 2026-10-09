import { Injectable, NotFoundException } from '@nestjs/common';
import type { SpaceMode } from '@prisma/client';
import type { SpaceDto, SpaceOwnerDto, SpacesUpdatedPatchDto } from '../../common/dto';
import { toAvatarVideoDto } from '../../common/dto/avatar-video.dto';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { AppConfigService } from '../app/app-config.service';
import { LinkMetadataService } from '../link-metadata/link-metadata.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveSpacePlaybackTitle } from './spaces-playback-title';
import { fetchYouTubeOEmbedTitle } from './youtube-oembed-title';
import { SpacesPresenceService } from './spaces-presence.service';

/** Reads a space as a viewer-specific DTO and owns the schedule-subscriber rows and lobby patch. */
@Injectable()
export class SpacesViewService {
  private readonly r2PublicBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly spacesPresence: SpacesPresenceService,
    private readonly linkMetadata: LinkMetadataService,
    private readonly realtime: PresenceRealtimeService,
  ) {
    this.r2PublicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? '';
  }

  async getSpaceById(id: string, viewerUserId?: string | null): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      include: { owner: true, _count: { select: { scheduleSubscribers: true } } },
    });
    if (!space) throw new NotFoundException();
    await this.ensureOwnerSubscribedIfScheduled(space);
    return this.toDto(space, {
      viewerUserId,
      subscriberCountOverride: await this.countNonOwnerSubscribers(space.id, space.ownerId),
    });
  }

  async ensureOwnerSubscribedIfScheduled(space: {
    id: string;
    ownerId: string;
    scheduledAt: Date | null;
  }): Promise<void> {
    if (!space.scheduledAt || space.scheduledAt.getTime() <= Date.now()) return;
    await this.ensureOwnerScheduleSubscription(space.id, space.ownerId);
  }

  /** Host is always on the reminder list for an upcoming schedule. */
  async ensureOwnerScheduleSubscription(spaceId: string, ownerId: string): Promise<void> {
    await this.prisma.spaceScheduleSubscriber.upsert({
      where: { spaceId_userId: { spaceId, userId: ownerId } },
      create: { spaceId, userId: ownerId },
      update: {},
    });
  }

  async toDto(
    space: {
      id: string;
      title: string | null;
      description: string | null;
      isActive: boolean;
      scheduledAt: Date | null;
      mode: SpaceMode;
      watchPartyUrl: string | null;
      radioStreamUrl: string | null;
      owner: {
        id: string;
        username: string | null;
        avatarKey: string | null; avatarVideoKey?: string | null; avatarVideoDurationMs?: number | null;
        avatarUpdatedAt: Date | null;
        premium: boolean;
        premiumPlus: boolean;
        isOrganization: boolean;
        verifiedStatus: 'none' | 'identity' | 'manual';
      };
      _count?: { scheduleSubscribers: number };
    },
    opts?: {
      viewerUserId?: string | null;
      listenerCountOverride?: number;
      viewerSubscribedOverride?: boolean;
      subscriberCountOverride?: number;
      viewerFollowsOwnerOverride?: boolean;
    },
  ): Promise<SpaceDto> {
    const owner: SpaceOwnerDto = {
      id: space.owner.id,
      username: space.owner.username,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: this.r2PublicBaseUrl,
        key: space.owner.avatarKey,
        updatedAt: space.owner.avatarUpdatedAt,
      }), avatarVideo: toAvatarVideoDto(space.owner, this.r2PublicBaseUrl),
      premium: space.owner.premium,
      premiumPlus: space.owner.premiumPlus,
      isOrganization: space.owner.isOrganization,
      verifiedStatus: space.owner.verifiedStatus,
    };

    const listenerCount =
      opts?.listenerCountOverride ?? (this.spacesPresence.getLobbyCountsBySpaceId()[space.id] ?? 0);

    let viewerSubscribed = opts?.viewerSubscribedOverride ?? false;
    if (opts?.viewerSubscribedOverride === undefined && opts?.viewerUserId) {
      const row = await this.prisma.spaceScheduleSubscriber.findUnique({
        where: { spaceId_userId: { spaceId: space.id, userId: opts.viewerUserId } },
        select: { userId: true },
      });
      viewerSubscribed = Boolean(row);
    }

    let viewerFollowsOwner = opts?.viewerFollowsOwnerOverride ?? false;
    if (
      opts?.viewerFollowsOwnerOverride === undefined &&
      opts?.viewerUserId &&
      opts.viewerUserId !== space.owner.id
    ) {
      const follow = await this.prisma.follow.findUnique({
        where: {
          followerId_followingId: {
            followerId: opts.viewerUserId,
            followingId: space.owner.id,
          },
        },
        select: { followerId: true },
      });
      viewerFollowsOwner = Boolean(follow);
    }

    const subscriberCount =
      opts?.subscriberCountOverride ??
      (await this.countNonOwnerSubscribers(space.id, space.owner.id));

    const playbackTitle = await resolveSpacePlaybackTitle({
      mode: space.mode,
      watchPartyUrl: space.watchPartyUrl,
      radioStreamUrl: space.radioStreamUrl,
      getLinkTitle: async (url) => {
        const youtubeTitle = await fetchYouTubeOEmbedTitle(url);
        if (youtubeTitle) return youtubeTitle;
        const meta = await this.linkMetadata.getMetadata(url);
        const title = meta?.title?.trim();
        return title || null;
      },
    });

    return {
      id: space.id,
      title: space.title,
      description: space.description,
      isActive: space.isActive,
      scheduledAt: space.scheduledAt ? space.scheduledAt.toISOString() : null,
      mode: space.mode,
      watchPartyUrl: space.watchPartyUrl,
      radioStreamUrl: space.radioStreamUrl,
      playbackTitle,
      owner,
      listenerCount,
      viewerSubscribed,
      subscriberCount,
      viewerFollowsOwner,
    };
  }

  /** Notify-me rows for non-hosts; host stays subscribed for soon reminders while scheduled. */
  async clearNonOwnerSubscribers(spaceId: string, ownerId: string): Promise<void> {
    await this.prisma.spaceScheduleSubscriber.deleteMany({
      where: { spaceId, userId: { not: ownerId } },
    });
  }

  async countNonOwnerSubscribers(spaceId: string, ownerId: string): Promise<number> {
    return this.prisma.spaceScheduleSubscriber.count({
      where: { spaceId, userId: { not: ownerId } },
    });
  }

  /** Lobby room only — viewer-agnostic patch (no viewerSubscribed / viewerFollowsOwner). */
  emitSpaceUpdated(spaceId: string, reason: string, patch: SpacesUpdatedPatchDto): void {
    this.realtime.emitSpacesUpdated({
      spaceId,
      version: new Date().toISOString(),
      reason,
      patch,
    });
  }
}
