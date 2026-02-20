import { Injectable } from '@nestjs/common';
import type { SpaceDto } from '../../common/dto';
import { RADIO_STATIONS } from '../radio/radio.constants';
import { SPACES } from './spaces.constants';

@Injectable()
export class SpacesService {
  private readonly stationById = new Map(RADIO_STATIONS.map((s) => [s.id, s]));
  private readonly spaceById = new Map(SPACES.map((s) => [s.id, s]));
  private readonly spaceIdByStationId = new Map(
    SPACES.filter((s) => Boolean(s.stationId)).map((s) => [String(s.stationId), s.id]),
  );

  listSpaces(): SpaceDto[] {
    return SPACES.map((s) => {
      const station = s.stationId ? this.stationById.get(s.stationId) ?? null : null;

      return {
        id: s.id,
        name: s.name,
        stationId: s.stationId ?? null,
        station: station
          ? {
              id: station.id,
              name: station.name,
              streamUrl: station.streamUrl,
              attributionName: station.attributionName ?? null,
              attributionUrl: station.attributionUrl ?? null,
            }
          : null,
        isBuiltin: true,
      };
    });
  }

  getSpaceIdByStationId(stationIdRaw: string): string | null {
    const stationId = String(stationIdRaw ?? '').trim();
    if (!stationId) return null;
    return this.spaceIdByStationId.get(stationId) ?? null;
  }

  getStationIdBySpaceId(spaceIdRaw: string): string | null {
    const spaceId = String(spaceIdRaw ?? '').trim();
    if (!spaceId) return null;
    const cfg = this.spaceById.get(spaceId) ?? null;
    return cfg?.stationId ?? null;
  }
}

