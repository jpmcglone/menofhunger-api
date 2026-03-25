import { Injectable, NotFoundException, ForbiddenException, ConflictException, BadRequestException } from '@nestjs/common';
import type { SpaceMode } from '@prisma/client';
import type { SpaceDto, SpaceOwnerDto, SpaceReactionDto } from '../../common/dto';
import { ALLOWED_REACTIONS, findReactionById } from '../../common/constants/reactions';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { SpacesPresenceService } from './spaces-presence.service';

@Injectable()
export class SpacesService {
  private readonly r2PublicBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly spacesPresence: SpacesPresenceService,
  ) {
    this.r2PublicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? '';
  }

  async createSpace(userId: string, data: { title: string; description?: string | null }): Promise<SpaceDto> {
    const existing = await this.prisma.space.findUnique({ where: { ownerId: userId } });
    if (existing) throw new ConflictException('You already have a space.');

    const space = await this.prisma.space.create({
      data: {
        ownerId: userId,
        title: data.title,
        description: data.description ?? null,
      },
      include: { owner: true },
    });

    return this.toDto(space);
  }

  async getSpaceById(id: string): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({
      where: { id },
      include: { owner: true },
    });
    if (!space) throw new NotFoundException();
    return this.toDto(space);
  }

  async getSpaceByOwnerUsername(username: string): Promise<SpaceDto> {
    const user = await this.prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!user) throw new NotFoundException();

    const space = await this.prisma.space.findUnique({
      where: { ownerId: user.id },
      include: { owner: true },
    });
    if (!space) throw new NotFoundException();
    return this.toDto(space);
  }

  async getSpaceByOwnerId(ownerId: string): Promise<SpaceDto | null> {
    const space = await this.prisma.space.findUnique({
      where: { ownerId },
      include: { owner: true },
    });
    if (!space) return null;
    return this.toDto(space);
  }

  async getOwnerIdForSpace(spaceId: string): Promise<string | null> {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: { ownerId: true },
    });
    return space?.ownerId ?? null;
  }

  async updateSpace(id: string, userId: string, data: { title?: string; description?: string | null }): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({ where: { id }, select: { ownerId: true } });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    const updated = await this.prisma.space.update({
      where: { id },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
      },
      include: { owner: true },
    });

    return this.toDto(updated);
  }

  async deleteSpace(id: string, userId: string): Promise<void> {
    const space = await this.prisma.space.findUnique({ where: { id }, select: { ownerId: true } });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();
    await this.prisma.space.delete({ where: { id } });
  }

  async activateSpace(id: string, userId: string): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({ where: { id }, select: { ownerId: true } });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    const updated = await this.prisma.space.update({
      where: { id },
      data: { isActive: true },
      include: { owner: true },
    });
    return this.toDto(updated);
  }

  async deactivateSpace(id: string, userId: string): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({ where: { id }, select: { ownerId: true } });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    const updated = await this.prisma.space.update({
      where: { id },
      data: { isActive: false },
      include: { owner: true },
    });
    return this.toDto(updated);
  }

  async activateSpaceByOwnerId(ownerId: string): Promise<void> {
    await this.prisma.space.updateMany({
      where: { ownerId, isActive: false },
      data: { isActive: true },
    });
  }

  async setMode(
    id: string,
    userId: string,
    data: { mode: SpaceMode; watchPartyUrl?: string | null; radioStreamUrl?: string | null },
  ): Promise<SpaceDto> {
    const space = await this.prisma.space.findUnique({ where: { id }, select: { ownerId: true } });
    if (!space) throw new NotFoundException();
    if (space.ownerId !== userId) throw new ForbiddenException();

    if (data.mode === 'WATCH_PARTY' && !data.watchPartyUrl?.trim()) {
      throw new BadRequestException('A YouTube URL is required for watch party mode.');
    }
    if (data.mode === 'RADIO' && !data.radioStreamUrl?.trim()) {
      throw new BadRequestException('A stream URL is required for radio mode.');
    }

    const updated = await this.prisma.space.update({
      where: { id },
      data: {
        mode: data.mode,
        watchPartyUrl: data.mode === 'WATCH_PARTY' ? (data.watchPartyUrl?.trim() ?? null) : null,
        radioStreamUrl: data.mode === 'RADIO' ? (data.radioStreamUrl?.trim() ?? null) : null,
      },
      include: { owner: true },
    });
    return this.toDto(updated);
  }

  async listActiveSpaces(): Promise<SpaceDto[]> {
    const spaces = await this.prisma.space.findMany({
      where: { isActive: true },
      include: { owner: true },
      orderBy: { createdAt: 'desc' },
    });

    const counts = this.spacesPresence.getLobbyCountsBySpaceId();

    return spaces
      .map((s) => this.toDto(s, counts[s.id]))
      .sort((a, b) => b.listenerCount - a.listenerCount);
  }

  async isSpaceActive(spaceId: string): Promise<boolean> {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: { isActive: true },
    });
    return space?.isActive ?? false;
  }

  async getSpaceMode(spaceId: string): Promise<SpaceMode | null> {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: { mode: true },
    });
    return space?.mode ?? null;
  }

  listReactions(): SpaceReactionDto[] {
    return [...ALLOWED_REACTIONS];
  }

  getReactionById(reactionIdRaw: string): SpaceReactionDto | null {
    return findReactionById(String(reactionIdRaw ?? ''));
  }

  private toDto(
    space: {
      id: string;
      title: string;
      description: string | null;
      isActive: boolean;
      mode: SpaceMode;
      watchPartyUrl: string | null;
      radioStreamUrl: string | null;
      owner: {
        id: string;
        username: string | null;
        avatarKey: string | null;
        avatarUpdatedAt: Date | null;
        premium: boolean;
        premiumPlus: boolean;
        isOrganization: boolean;
        verifiedStatus: 'none' | 'identity' | 'manual';
      };
    },
    listenerCountOverride?: number,
  ): SpaceDto {
    const owner: SpaceOwnerDto = {
      id: space.owner.id,
      username: space.owner.username,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: this.r2PublicBaseUrl,
        key: space.owner.avatarKey,
        updatedAt: space.owner.avatarUpdatedAt,
      }),
      premium: space.owner.premium,
      premiumPlus: space.owner.premiumPlus,
      isOrganization: space.owner.isOrganization,
      verifiedStatus: space.owner.verifiedStatus,
    };

    const listenerCount = listenerCountOverride ?? (this.spacesPresence.getLobbyCountsBySpaceId()[space.id] ?? 0);

    return {
      id: space.id,
      title: space.title,
      description: space.description,
      isActive: space.isActive,
      mode: space.mode,
      watchPartyUrl: space.watchPartyUrl,
      radioStreamUrl: space.radioStreamUrl,
      owner,
      listenerCount,
    };
  }
}
