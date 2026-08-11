import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ApiTags } from '@nestjs/swagger';
import type { SpaceDto, SpaceLobbyCountsDto, SpaceReactionDto } from '../../common/dto';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
import { SpacesService } from './spaces.service';
import { SpacesPresenceService } from './spaces-presence.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';

const createSpaceSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullish(),
});

const updateSpaceSchema = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullish(),
});

const setModeSchema = z.object({
  mode: z.enum(['NONE', 'WATCH_PARTY', 'RADIO']),
  watchPartyUrl: z.string().trim().max(2000).nullish(),
  radioStreamUrl: z.string().trim().max(2000).nullish(),
});

const setScheduleSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
});

@ApiTags('Radio & Spaces')
@Controller('spaces')
export class SpacesController {
  constructor(
    private readonly spaces: SpacesService,
    private readonly spacesPresence: SpacesPresenceService,
    private readonly redis: RedisService,
  ) {}

  @UseGuards(AuthGuard)
  @Post()
  async create(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ): Promise<{ data: SpaceDto }> {
    const parsed = createSpaceSchema.parse(body);
    const space = await this.spaces.createSpace(userId, parsed);
    return { data: space };
  }

  @UseGuards(OptionalAuthGuard)
  @Get()
  async list(@OptionalCurrentUserId() userId?: string | null): Promise<{ data: SpaceDto[] }> {
    const spaces = await this.spaces.listLobbySpaces(userId ?? null);
    return { data: spaces };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('reactions')
  listReactions(): { data: SpaceReactionDto[] } {
    return { data: this.spaces.listReactions() };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('lobby-counts')
  async lobbyCountsHttp(): Promise<{ data: SpaceLobbyCountsDto }> {
    let countsBySpaceId: Record<string, number> | null = null;
    try {
      countsBySpaceId = await this.redis.getJson<Record<string, number>>(RedisKeys.spacesLobbyCounts());
    } catch {
      // fall through to in-memory
    }
    return {
      data: { countsBySpaceId: countsBySpaceId ?? this.spacesPresence.getLobbyCountsBySpaceId() },
    };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('by-username/:username')
  async getByUsername(
    @Param('username') username: string,
    @OptionalCurrentUserId() userId?: string | null,
  ): Promise<{ data: SpaceDto }> {
    const space = await this.spaces.getSpaceByOwnerUsername(username, userId ?? null);
    return { data: space };
  }

  @UseGuards(OptionalAuthGuard)
  @Get(':id')
  async getById(
    @Param('id') id: string,
    @OptionalCurrentUserId() userId?: string | null,
  ): Promise<{ data: SpaceDto }> {
    const space = await this.spaces.getSpaceById(id, userId ?? null);
    return { data: space };
  }

  @UseGuards(AuthGuard)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ): Promise<{ data: SpaceDto }> {
    const parsed = updateSpaceSchema.parse(body);
    const space = await this.spaces.updateSpace(id, userId, parsed);
    return { data: space };
  }

  @UseGuards(AuthGuard)
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  async activate(
    @Param('id') id: string,
    @CurrentUserId() userId: string,
  ): Promise<{ data: SpaceDto }> {
    const space = await this.spaces.activateSpace(id, userId);
    return { data: space };
  }

  @UseGuards(AuthGuard)
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  async deactivate(
    @Param('id') id: string,
    @CurrentUserId() userId: string,
  ): Promise<{ data: SpaceDto }> {
    const space = await this.spaces.deactivateSpace(id, userId);
    return { data: space };
  }

  @UseGuards(AuthGuard)
  @Patch(':id/mode')
  async setMode(
    @Param('id') id: string,
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ): Promise<{ data: SpaceDto }> {
    const parsed = setModeSchema.parse(body);
    const space = await this.spaces.setMode(id, userId, parsed);
    return { data: space };
  }

  @UseGuards(AuthGuard)
  @Post(':id/schedule')
  @HttpCode(HttpStatus.OK)
  async setSchedule(
    @Param('id') id: string,
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ): Promise<{ data: SpaceDto }> {
    const parsed = setScheduleSchema.parse(body);
    const space = await this.spaces.setSchedule(id, userId, parsed.scheduledAt);
    return { data: space };
  }

  @UseGuards(AuthGuard)
  @Delete(':id/schedule')
  @HttpCode(HttpStatus.OK)
  async clearSchedule(
    @Param('id') id: string,
    @CurrentUserId() userId: string,
  ): Promise<{ data: SpaceDto }> {
    const space = await this.spaces.clearSchedule(id, userId);
    return { data: space };
  }

  @UseGuards(AuthGuard)
  @Post(':id/schedule/subscribe')
  @HttpCode(HttpStatus.OK)
  async subscribe(
    @Param('id') id: string,
    @CurrentUserId() userId: string,
  ): Promise<{ data: SpaceDto }> {
    const space = await this.spaces.subscribeToSchedule(id, userId);
    return { data: space };
  }

  @UseGuards(AuthGuard)
  @Delete(':id/schedule/subscribe')
  @HttpCode(HttpStatus.OK)
  async unsubscribe(
    @Param('id') id: string,
    @CurrentUserId() userId: string,
  ): Promise<{ data: SpaceDto }> {
    const space = await this.spaces.unsubscribeFromSchedule(id, userId);
    return { data: space };
  }

  @UseGuards(AuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    await this.spaces.deleteSpace(id, userId);
  }
}
