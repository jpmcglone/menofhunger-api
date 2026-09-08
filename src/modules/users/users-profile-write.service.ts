import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PublicProfileCacheService } from "./public-profile-cache.service";
import { UsersMeRealtimeService } from "./users-me-realtime.service";
import { UsersPublicRealtimeService } from "./users-public-realtime.service";

/** Canonical profile commit and cross-client invalidation for HTTP and delegated actions. */
@Injectable()
export class UsersProfileWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: PublicProfileCacheService<{
      id: string;
      username: string | null;
    }>,
    private readonly me: UsersMeRealtimeService,
    private readonly publicUpdates: UsersPublicRealtimeService,
  ) {}
  async commit(
    userId: string,
    data: Prisma.UserUpdateInput,
    emailChanged = false,
  ) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
    });
    await this.cache.invalidateForUser({
      id: updated.id,
      username: updated.username ?? null,
    });
    await this.publicUpdates.emitPublicProfileUpdated(updated.id);
    this.me.emitMeUpdatedFromUser(
      updated,
      emailChanged ? "email_changed" : "profile_changed",
    );
    return updated;
  }
}
