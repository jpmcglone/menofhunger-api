import { Controller, Get } from '@nestjs/common';
import type { SpaceDto, SpaceReactionDto } from '../../common/dto';
import { SpacesService } from './spaces.service';

@Controller('spaces')
export class SpacesController {
  constructor(private readonly spaces: SpacesService) {}

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
}

