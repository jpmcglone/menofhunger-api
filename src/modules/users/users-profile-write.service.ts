import { Injectable } from "@nestjs/common";
import { AuthService } from "../auth/auth.service";
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
    private readonly auth: AuthService,
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
    // /auth/me and auth guards cache the full user, independently of public profiles.
    // Clear every device's snapshot before announcing or returning the saved profile.
    await this.auth.bustSessionCachesForUser(updated.id);
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
