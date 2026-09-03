import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ApiTags } from '@nestjs/swagger';
import type { SpaceDto, SpaceLobbyCountsDto, SpaceReactionDto } from '../../common/dto';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
import { PresenceRedisStateService } from '../presence/presence-redis-state.service';
import { SpacesService } from './spaces.service';
import { SpacesPresenceService } from './spaces-presence.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';

const createSpaceSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullish(),
});

const updateSpaceSchema = z.object({
  title: z.union([z.string().trim().max(100), z.null()]).optional()
    .transform((value) => (value === '' ? null : value)),
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
    private readonly presenceRedis: PresenceRedisStateService,
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
    // Always re-aggregate from live instance hashes — the Redis snapshot alone
    // can linger after everyone leaves and inflate the Spaces nav "(N)" count.
    const local = this.spacesPresence.getLobbyCountsBySpaceId();
    const countsBySpaceId = await this.presenceRedis.syncAndAggregateLobbyCounts(local);
    void this.redis
      .setJson(RedisKeys.spacesLobbyCounts(), countsBySpaceId, { ttlSeconds: 30 })
      .catch(() => undefined);
    return { data: { countsBySpaceId } };
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
