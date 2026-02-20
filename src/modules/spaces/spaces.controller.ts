import { Controller, Get } from '@nestjs/common';
import type { SpaceDto } from '../../common/dto';
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
}

