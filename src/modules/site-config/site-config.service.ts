import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type SiteConfigRow = {
  id: number;
  postsPerWindow: number;
  windowSeconds: number;
  verifiedPostsPerWindow: number;
  verifiedWindowSeconds: number;
  premiumPostsPerWindow: number;
  premiumWindowSeconds: number;
  autoVerifyNewUsers: boolean;
  autoVerifyRecruiterId: string | null;
};

const DEFAULT_SITE_CONFIG: SiteConfigRow = {
  id: 1,
  postsPerWindow: 5,
  windowSeconds: 300,
  verifiedPostsPerWindow: 5,
  verifiedWindowSeconds: 300,
  premiumPostsPerWindow: 5,
  premiumWindowSeconds: 300,
  autoVerifyNewUsers: false,
  autoVerifyRecruiterId: null,
};

/**
 * Shared reader for the singleton SiteConfig row (id=1).
 * Post rate-limit callers use the short TTL cache; auto-verify decisions
 * should call `getUncached()` so an admin toggle takes effect immediately.
 */
@Injectable()
export class SiteConfigService {
  private cache: { value: SiteConfigRow; expiresAt: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<SiteConfigRow> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;

    const value = await this.getUncached();
    this.cache = { value, expiresAt: now + 5 * 60 * 1000 };
    return value;
  }

  async getUncached(): Promise<SiteConfigRow> {
    const cfg = await this.prisma.siteConfig.findUnique({ where: { id: 1 } });
    if (!cfg) return { ...DEFAULT_SITE_CONFIG };
    return {
      id: cfg.id,
      postsPerWindow: cfg.postsPerWindow,
      windowSeconds: cfg.windowSeconds,
      verifiedPostsPerWindow: cfg.verifiedPostsPerWindow,
      verifiedWindowSeconds: cfg.verifiedWindowSeconds,
      premiumPostsPerWindow: cfg.premiumPostsPerWindow,
      premiumWindowSeconds: cfg.premiumWindowSeconds,
      autoVerifyNewUsers: cfg.autoVerifyNewUsers,
      autoVerifyRecruiterId: cfg.autoVerifyRecruiterId ?? null,
    };
  }

  /**
   * Whether a user with the given recruiter should be auto-verified.
   * Blank recruiter filter = all new signups; set filter = only that recruiter's recruits.
   */
  shouldAutoVerify(cfg: Pick<SiteConfigRow, 'autoVerifyNewUsers' | 'autoVerifyRecruiterId'>, recruitedById: string | null): boolean {
    if (!cfg.autoVerifyNewUsers) return false;
    if (cfg.autoVerifyRecruiterId == null) return true;
    return Boolean(recruitedById && cfg.autoVerifyRecruiterId === recruitedById);
  }

  invalidate(): void {
    this.cache = null;
  }
}
