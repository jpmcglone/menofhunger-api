import { Controller, Get } from '@nestjs/common';
import { RADIO_STATIONS } from './radio.constants';
import type { RadioStationDto } from '../../common/dto';

@Controller('radio')
export class RadioController {
  /**
   * GET /radio/stations -> [RadioStation]
   */
  @Get('stations')
  stations(): { data: RadioStationDto[] } {
    return {
      data: RADIO_STATIONS.map((s) => ({
        id: s.id,
        name: s.name,
        streamUrl: s.streamUrl,
        attributionName: s.attributionName ?? null,
        attributionUrl: s.attributionUrl ?? null,
      })),
    };
  }
}

