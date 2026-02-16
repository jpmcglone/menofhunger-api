import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AppConfigService } from '../app/app-config.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';

function safeBaseUrl(raw: string | null): string {
  const base = (raw ?? '').trim() || 'https://menofhunger.com';
  return base.replace(/\/$/, '');
}

@Injectable()
export class NotificationsEmailCron {
  private readonly logger = new Logger(NotificationsEmailCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly appConfig: AppConfigService,
    private readonly jobs: JobsService,
  ) {}

  /** Every 15 minutes: if you have undelivered notifications, send a lightweight nudge email (if enabled). */
  @Cron('*/15 * * * *')
  async sendNewNotificationsNudges(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    try {
      await this.jobs.enqueueCron(JOBS.notificationsEmailNudges, {}, 'cron:notificationsEmailNudges', {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  async runSendNewNotificationsNudges(): Promise<void> {
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    const now = new Date();
    const cutoff = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
    const notificationsUrl = `${baseUrl}/notifications`;

    const prefs = await this.prisma.notificationPreferences.findMany({
      where: {
        emailNewNotifications: true,
        OR: [{ lastEmailNewNotificationsSentAt: null }, { lastEmailNewNotificationsSentAt: { lt: cutoff } }],
        user: { email: { not: null } },
      },
      select: {
        userId: true,
        user: { select: { email: true, username: true, name: true } },
      },
      take: 500,
    });

    for (const p of prefs) {
      const to = (p.user.email ?? '').trim();
      if (!to) continue;

      const undelivered = await this.prisma.notification.count({
        where: { recipientUserId: p.userId, deliveredAt: null },
      });
      if (undelivered <= 0) continue;

      const recent = await this.prisma.notification.findMany({
        where: { recipientUserId: p.userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
        select: { title: true, body: true },
      });

      const lines = recent
        .map((n) => `- ${(n.title ?? 'New notification').trim()}${(n.body ?? '').trim() ? ` — ${(n.body ?? '').trim()}` : ''}`)
        .filter(Boolean);

      const greetingName = (p.user.name ?? p.user.username ?? '').trim();
      const greeting = greetingName ? `Hey ${greetingName},` : `Hey,`;

      const text = [
        greeting,
        '',
        `You have ${undelivered} new notification${undelivered === 1 ? '' : 's'} on Men of Hunger.`,
        '',
        ...(lines.length ? ['Recent:', ...lines, ''] : []),
        `Open: ${notificationsUrl}`,
        '',
        `You can change email notification settings in Settings → Notifications.`,
      ].join('\n');

      const sent = await this.email.sendText({
        to,
        subject: `You have ${undelivered} new notification${undelivered === 1 ? '' : 's'}`,
        text,
      });

      if (sent.sent) {
        await this.prisma.notificationPreferences.update({
          where: { userId: p.userId },
          data: { lastEmailNewNotificationsSentAt: now },
        });
      }
    }
  }

  /** Weekly digest (Mondays 15:00 UTC ~ 10am ET). */
  @Cron('0 15 * * 1')
  async sendWeeklyDigest(): Promise<void> {
    if (!this.appConfig.runSchedulers()) return;
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    try {
      // Weekly schedule already gates frequency; stable jobId prevents overlap on deploys.
      await this.jobs.enqueueCron(JOBS.notificationsWeeklyDigest, {}, 'cron:notificationsWeeklyDigest', {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  async runSendWeeklyDigest(): Promise<void> {
    const emailCfg = this.appConfig.email();
    if (!emailCfg) return;

    const now = new Date();
    const cutoff = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
    const notificationsUrl = `${baseUrl}/notifications`;

    const prefs = await this.prisma.notificationPreferences.findMany({
      where: {
        emailDigestWeekly: true,
        OR: [{ lastEmailDigestSentAt: null }, { lastEmailDigestSentAt: { lt: cutoff } }],
        user: { email: { not: null } },
      },
      select: {
        userId: true,
        user: { select: { email: true, username: true, name: true } },
      },
      take: 500,
    });

    for (const p of prefs) {
      const to = (p.user.email ?? '').trim();
      if (!to) continue;

      const counts = await this.prisma.notification.groupBy({
        by: ['kind'],
        where: { recipientUserId: p.userId, createdAt: { gte: since } },
        _count: { kind: true },
      });

      const total = counts.reduce((sum, c) => sum + (c._count?.kind ?? 0), 0);
      if (total <= 0) continue;

      const lines = counts
        .map((c) => {
          const n = c._count?.kind ?? 0;
          return `- ${c.kind}: ${n}`;
        })
        .sort();

      const greetingName = (p.user.name ?? p.user.username ?? '').trim();
      const greeting = greetingName ? `Hey ${greetingName},` : `Hey,`;

      const text = [
        greeting,
        '',
        `Your weekly Men of Hunger digest:`,
        '',
        `Last 7 days: ${total} notification${total === 1 ? '' : 's'}`,
        ...lines,
        '',
        `Open: ${notificationsUrl}`,
        '',
        `You can change digest settings in Settings → Notifications.`,
      ].join('\n');

      const sent = await this.email.sendText({
        to,
        subject: 'Your weekly Men of Hunger digest',
        text,
      });

      if (sent.sent) {
        await this.prisma.notificationPreferences.update({
          where: { userId: p.userId },
          data: { lastEmailDigestSentAt: now },
        });
      } else {
        this.logger.debug(`[digest] not sent to userId=${p.userId} reason=${sent.reason ?? 'unknown'}`);
      }
    }
  }
}

