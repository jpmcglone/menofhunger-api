import { Injectable } from '@nestjs/common';
import { UsersRealtimeService } from './users-realtime.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';

@Injectable()
export class UsersPublicRealtimeService {
  constructor(
    private readonly usersRealtime: UsersRealtimeService,
    private readonly presenceRealtime: PresenceRealtimeService,
  ) {}

  /**
   * Emit public-profile refresh to the user + their related users (followers/following).
   * This is best-effort and intentionally conservative (does not include private fields).
   */
  async emitPublicProfileUpdated(userId: string): Promise<void> {
    const id = (userId ?? '').trim();
    if (!id) return;
    try {
      const profile = await this.usersRealtime.getPublicProfileDtoByUserId(id);
      if (!profile) return;
      const related = await this.usersRealtime.listRelatedUserIds(id);
      const recipients = new Set<string>([id, ...related].filter(Boolean));
      this.presenceRealtime.emitUsersSelfUpdated(recipients, { user: profile });
    } catch {
      // Best-effort
    }
  }
}

