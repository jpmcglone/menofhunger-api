import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { toUserListDto } from '../../common/dto';
import type { MembersMapChangedPayloadDto } from '../../common/dto/members-map.dto';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';

/** The fields that decide whether and where someone counts on the members map. */
export type MembersMapSnapshot = {
  usernameIsSet: boolean;
  bannedAt: Date | null;
  isBot: boolean;
  locationState: string | null;
};

export const MEMBERS_MAP_SNAPSHOT_SELECT = {
  usernameIsSet: true,
  bannedAt: true,
  isBot: true,
  locationState: true,
} as const;

function countsOnMap(s: MembersMapSnapshot): boolean {
  return s.usernameIsSet && !s.bannedAt && !s.isBot;
}

function stateKey(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toUpperCase();
  return s || null;
}

/** What changed on the map between two snapshots of one user, or null when nothing did. */
export function membersMapChange(
  before: MembersMapSnapshot,
  after: MembersMapSnapshot,
): Omit<MembersMapChangedPayloadDto, 'user'> | null {
  const was = countsOnMap(before);
  const is = countsOnMap(after);
  const prev = stateKey(before.locationState);
  const next = stateKey(after.locationState);
  if (!was && is) return { kind: 'joined', state: next, previousState: null };
  if (was && !is) return { kind: 'left', state: null, previousState: prev };
  if (was && is && prev !== next) return { kind: 'moved', state: next, previousState: prev };
  return null;
}

/**
 * Live membership updates for the members map: someone joined, moved state, or left.
 * Emitted after the write commits; the counts-only summary cache is dropped so the next
 * fetch agrees with the event.
 */
@Injectable()
export class MembersMapRealtimeService {
  private readonly logger = new Logger(MembersMapRealtimeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly redis: RedisService,
    private readonly realtime: PresenceRealtimeService,
  ) {}

  notifyChange(userId: string, before: MembersMapSnapshot, after: MembersMapSnapshot): void {
    const change = membersMapChange(before, after);
    if (!change) return;
    void this.emit(userId, change).catch((err) =>
      this.logger.warn(`[members-map] change emit failed userId=${userId}: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  private async emit(userId: string, change: Omit<MembersMapChangedPayloadDto, 'user'>): Promise<void> {
    await this.redis.del(RedisKeys.membersMapCounts()).catch(() => undefined);
    const row =
      change.kind === 'left'
        ? null
        : await this.prisma.user.findUnique({ where: { id: userId }, select: USER_LIST_SELECT });
    const user = row ? toUserListDto(row, this.appConfig.r2()?.publicBaseUrl ?? null) : null;
    this.realtime.emitMembersMapChanged(change, user);
  }
}
