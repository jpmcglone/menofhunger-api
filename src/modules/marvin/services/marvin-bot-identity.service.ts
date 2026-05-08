import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../app/app-config.service';
import { MARV_BOT_TYPE } from '../marvin.constants';

/**
 * Resolves and (in non-test envs) lazily seeds the Marv bot user.
 *
 * Marv is a real `User` row so all existing posts/DM/notification plumbing works as-is.
 * This service:
 *
 *  1. On boot, looks up the configured Marv user (preferring `MARV_USER_ID`, falling
 *     back to a username lookup).
 *  2. If missing, upserts a User row with `isBot=true`, `botType='marvin'`, `premium=true`.
 *  3. Caches the resolved id in memory so subsequent callers (`MarvinMentionDetector`,
 *     `MarvinPublicReplyProcessor`, etc.) never hit the database.
 *
 * The cache is intentionally a single in-memory string; if the marv user is somehow
 * deleted at runtime, restart the process. We don't watch for deletions.
 */
@Injectable()
export class MarvinBotIdentityService implements OnModuleInit {
  private readonly logger = new Logger(MarvinBotIdentityService.name);
  private cachedUserId: string | null = null;
  private cachedUsernameLower: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Best-effort: resolve early so the first inbound request doesn't pay the lookup cost.
    // Errors here are logged and swallowed — we re-attempt lazily on getMarvUserId().
    try {
      await this.ensureMarvUser();
    } catch (err) {
      this.logger.warn(
        `[marv] Could not resolve/seed Marv user on boot: ${err instanceof Error ? err.message : String(err)}. ` +
          'Will retry on first request.',
      );
    }
  }

  /** Returns the Marv user id, looking up + seeding if necessary. */
  async getMarvUserId(): Promise<string | null> {
    if (this.cachedUserId) return this.cachedUserId;
    return await this.ensureMarvUser();
  }

  /** Returns the lowercase Marv username (used by mention detection). */
  marvUsernameLower(): string {
    if (this.cachedUsernameLower) return this.cachedUsernameLower;
    return this.appConfig.marvBot().username.trim().toLowerCase();
  }

  /** Synchronous best-effort id lookup; returns null if marv hasn't been resolved yet. */
  cachedMarvUserId(): string | null {
    return this.cachedUserId;
  }

  /** Returns true when the given user id matches the cached Marv user id. */
  isMarvUser(userId: string | null | undefined): boolean {
    if (!userId || !this.cachedUserId) return false;
    return userId === this.cachedUserId;
  }

  private async ensureMarvUser(): Promise<string> {
    const cfg = this.appConfig.marvBot();
    const username = cfg.username.trim();
    const usernameLower = username.toLowerCase();

    // Prefer explicit env id when provided.
    if (cfg.userId) {
      const byId = await this.prisma.user.findUnique({
        where: { id: cfg.userId },
        select: { id: true, username: true },
      });
      if (byId) {
        this.cachedUserId = byId.id;
        this.cachedUsernameLower = byId.username?.toLowerCase() ?? usernameLower;
        return byId.id;
      }
      this.logger.warn(`[marv] MARV_USER_ID="${cfg.userId}" not found; falling back to username lookup.`);
    }

    // Username lookup (case-insensitive).
    const byUsername = (
      await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "User"
        WHERE LOWER("username") = ${usernameLower}
        LIMIT 1
      `
    )[0];
    if (byUsername) {
      // Re-assert bot flags + premium in case they got reset by an earlier admin tool.
      await this.prisma.user.update({
        where: { id: byUsername.id },
        data: {
          isBot: true,
          botType: MARV_BOT_TYPE,
          premium: true,
          usernameIsSet: true,
          name: cfg.displayName,
          bio: cfg.bio,
        },
      });
      this.cachedUserId = byUsername.id;
      this.cachedUsernameLower = usernameLower;
      return byUsername.id;
    }

    // Create the bot user. Use a stable phone (configured) so re-seeding is idempotent.
    const created = await this.prisma.user.create({
      data: {
        phone: cfg.phone,
        username,
        usernameIsSet: true,
        name: cfg.displayName,
        bio: cfg.bio,
        isBot: true,
        botType: MARV_BOT_TYPE,
        premium: true,
        // Marv is also "verified" so he can post anywhere a verified user can.
        verifiedStatus: 'manual',
        verifiedAt: new Date(),
        // Bot has no birthday/onboarding requirements — but the User model permits null here.
        menOnlyConfirmed: true,
        // Seed an initial credit row so admin tooling never sees a NULL bucket for marv.
        marvinCreditBalance: {
          create: {
            credits: 0,
            lastRefilledAt: new Date(),
          },
        },
      },
      select: { id: true },
    });
    this.logger.log(`[marv] Seeded Marv bot user (id=${created.id}, username=${username}).`);

    // Seed an introductory post so Marv's profile isn't empty on first run.
    await this.prisma.post.create({
      data: {
        userId: created.id,
        body: 'Hello, men!',
        visibility: 'verifiedOnly',
        kind: 'regular',
      },
    });
    this.logger.log(`[marv] Seeded Marv intro post.`);

    this.cachedUserId = created.id;
    this.cachedUsernameLower = usernameLower;
    return created.id;
  }
}
