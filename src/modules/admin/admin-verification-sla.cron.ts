import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AppConfigService } from '../app/app-config.service';
import { SlackService } from '../../common/slack/slack.service';

export const VERIFICATION_SLA_HOURS = 24;

/**
 * Hourly: tells admins when pending verification requests have waited past the SLA.
 * Each request alerts once; the atomic `slaAlertedAt` claim keeps parallel instances from
 * double-sending.
 */
@Injectable()
export class AdminVerificationSlaCron {
  private readonly logger = new Logger(AdminVerificationSlaCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly appConfig: AppConfigService,
    private readonly slack: SlackService,
  ) {}

  @Cron('17 * * * *')
  async tick(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.alertOverdue(new Date());
    } catch (err) {
      this.logger.error(`Verification SLA check failed: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  async alertOverdue(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - VERIFICATION_SLA_HOURS * 60 * 60 * 1000);
    const overdue = await this.prisma.verificationRequest.findMany({
      where: { status: 'pending', slaAlertedAt: null, createdAt: { lt: cutoff } },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    if (overdue.length === 0) return 0;

    const claimed = await this.prisma.verificationRequest.updateMany({
      where: { id: { in: overdue.map((r) => r.id) }, status: 'pending', slaAlertedAt: null },
      data: { slaAlertedAt: now },
    });
    if (claimed.count === 0) return 0;

    const oldestHours = Math.floor((now.getTime() - overdue[0]!.createdAt.getTime()) / 3_600_000);
    this.slack.notifyVerificationSlaBreached({ count: claimed.count, oldestHours });
    await this.emailAdmins(claimed.count, oldestHours);
    return claimed.count;
  }

  private async emailAdmins(count: number, oldestHours: number): Promise<void> {
    if (!this.appConfig.email()) return;
    const admins = await this.prisma.user.findMany({
      where: { siteAdmin: true, email: { not: null }, emailVerifiedAt: { not: null }, bannedAt: null },
      select: { email: true },
    });
    const noun = count === 1 ? 'request has' : 'requests have';
    const subject = `${count} verification ${count === 1 ? 'request' : 'requests'} waiting over ${VERIFICATION_SLA_HOURS}h`;
    const text = `${count} verification ${noun} waited more than ${VERIFICATION_SLA_HOURS} hours (oldest ${oldestHours}h).\n\nReview: https://menofhunger.com/admin/verification`;
    for (const admin of admins) {
      if (!admin.email) continue;
      const res = await this.email.sendEmail({ to: admin.email, subject, text, category: 'transactional' });
      if (!res.sent) this.logger.warn(`Verification SLA email failed for an admin`);
    }
  }
}
