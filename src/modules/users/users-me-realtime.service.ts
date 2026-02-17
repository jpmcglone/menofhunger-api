import { Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { toUserDto } from '../../common/dto/user.dto';

@Injectable()
export class UsersMeRealtimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
  ) {}

  emitMeUpdatedFromUser(user: User, reason?: string): void {
    try {
      this.presenceRealtime.emitUsersMeUpdated(user.id, {
        user: toUserDto(user, this.appConfig.r2()?.publicBaseUrl ?? null),
        ...(reason ? { reason } : {}),
      });
    } catch {
      // Best-effort
    }
  }

  async emitMeUpdated(userId: string, reason?: string): Promise<void> {
    const id = (userId ?? '').trim();
    if (!id) return;
    try {
      const user = await this.prisma.user.findUnique({ where: { id } });
      if (!user) return;
      this.emitMeUpdatedFromUser(user, reason);
    } catch {
      // Best-effort
    }
  }
}

