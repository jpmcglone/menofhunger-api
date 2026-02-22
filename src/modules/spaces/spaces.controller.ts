import { Controller, Get } from '@nestjs/common';
import type { SpaceDto, SpaceLobbyCountsDto, SpaceReactionDto } from '../../common/dto';
import { SpacesService } from './spaces.service';
import { SpacesPresenceService } from './spaces-presence.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';

@Controller('spaces')
export class SpacesController {
  constructor(
    private readonly spaces: SpacesService,
    private readonly spacesPresence: SpacesPresenceService,
    private readonly redis: RedisService,
  ) {}

  /**
   * GET /spaces -> [Space]
   */
  @Get()
  list(): { data: SpaceDto[] } {
    return { data: this.spaces.listSpaces() };
  }

  /**
   * GET /spaces/reactions -> [SpaceReaction]
   */
  @Get('reactions')
  listReactions(): { data: SpaceReactionDto[] } {
    return { data: this.spaces.listReactions() };
  }

  /**
   * GET /spaces/lobby-counts -> SpaceLobbyCountsDto
   * Returns current lobby counts for all spaces.
   * Serves from Redis cache (written on every join/leave); falls back to in-memory snapshot.
   */
  @Get('lobby-counts')
  async lobbyCountsHttp(): Promise<{ data: SpaceLobbyCountsDto }> {
    let countsBySpaceId: Record<string, number> | null = null;
    try {
      countsBySpaceId = await this.redis.getJson<Record<string, number>>(RedisKeys.spacesLobbyCounts());
    } catch {
      // ignore; fall through to in-memory
    }
    return {
      data: { countsBySpaceId: countsBySpaceId ?? this.spacesPresence.getLobbyCountsBySpaceId() },
    };
  }
}

