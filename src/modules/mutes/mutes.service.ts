import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';

/** One-way mutes: the muter stops seeing the muted user's posts and notifications. */
@Injectable()
export class MutesService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  /** Users the viewer has muted (Redis-cached, 5 min; busted on mute/unmute). */
  async mutedIds(viewerUserId: string | null | undefined): Promise<Set<string>> {
    if (!viewerUserId) return new Set();
    const cacheKey = RedisKeys.viewerMutedIds(viewerUserId);
    if (this.redis) {
      try {
        const cached = await this.redis.getJson<string[]>(cacheKey);
        if (cached) return new Set(cached);
      } catch {
        // Fall through to the database.
      }
    }
    const rows = await this.prisma.userMute.findMany({ where: { muterId: viewerUserId }, select: { mutedId: true } });
    const ids = rows.map((r) => r.mutedId);
    if (this.redis) void this.redis.setJson(cacheKey, ids, { ttlSeconds: 5 * 60 }).catch(() => undefined);
    return new Set(ids);
  }

  async hasMuted(muterId: string, mutedId: string | null | undefined): Promise<boolean> {
    if (!mutedId || muterId === mutedId) return false;
    return (await this.mutedIds(muterId)).has(mutedId);
  }

  async mute(muterId: string, mutedId: string): Promise<void> {
    if (muterId === mutedId) throw new BadRequestException('You cannot mute yourself.');
    const target = await this.prisma.user.findUnique({ where: { id: mutedId }, select: { id: true } });
    if (!target) throw new NotFoundException('User not found.');
    await this.prisma.userMute.upsert({
      where: { muterId_mutedId: { muterId, mutedId } },
      create: { muterId, mutedId },
      update: {},
    });
    await this.bust(muterId);
  }

  async unmute(muterId: string, mutedId: string): Promise<void> {
    await this.prisma.userMute.deleteMany({ where: { muterId, mutedId } });
    await this.bust(muterId);
  }

  private async bust(muterId: string) {
    if (this.redis) await this.redis.del(RedisKeys.viewerMutedIds(muterId)).catch(() => undefined);
  }
}
