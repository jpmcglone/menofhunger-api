import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { AffiliateService, AFFILIATE_PREMIUM_RETENTION_DAYS } from './affiliate.service';

@Injectable()
export class AffiliateRetentionCron {
  private readonly logger = new Logger(AffiliateRetentionCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly affiliate: AffiliateService,
  ) {}

  /** Daily at 03:00 UTC — award the 60-day Premium retention milestone for eligible recruits. */
  @Cron('0 3 * * *')
  async checkRetention() {
    if (!this.appConfig.runSchedulers()) return;
    await this.runCheckRetention();
  }

  async runCheckRetention() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();

    try {
      const cutoff = new Date(Date.now() - AFFILIATE_PREMIUM_RETENTION_DAYS * 24 * 60 * 60 * 1000);

      // Find recruits who:
      // - Had their first Premium month (referralBonusGrantedAt set, which fires on first Stripe payment)
      // - Still have an active premium subscription
      // - Have a recruiter who is enrolled in the pilot
      // - Do NOT yet have a premium60d earning recorded
      const eligible = await this.prisma.user.findMany({
        where: {
          referralBonusGrantedAt: { not: null, lte: cutoff },
          premium: true,
          recruitedBy: { affiliateAt: { not: null } },
          affiliateEarningsAsRecruit: {
            none: { type: 'premium60d' },
          },
        },
        select: { id: true },
      });

      if (eligible.length === 0) {
        return;
      }

      this.logger.log(`[affiliate-retention] Found ${eligible.length} recruit(s) eligible for 60-day milestone`);

      for (const recruit of eligible) {
        try {
          await this.affiliate.maybeRecordEarning(recruit.id, 'premium60d');
        } catch (err) {
          this.logger.warn(`[affiliate-retention] Failed for recruit=${recruit.id}: ${err}`);
        }
      }

      const ms = Date.now() - startedAt;
      this.logger.log(`[affiliate-retention] Done in ${ms}ms`);
    } catch (err) {
      this.logger.warn(`[affiliate-retention] Cron failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
