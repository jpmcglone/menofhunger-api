import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AppConfigService } from '../app/app-config.service';
import { buildGreeting, getVerifiedRecipientEmail } from '../email/email-send.helpers';
import { buildOnboardingNudgeEmail, pickOnboardingNudge, type OnboardingStage } from '../email/onboarding-nudge';
import { NOT_DELETED } from '../../common/prisma/where';

const DAY_MS = 24 * 60 * 60 * 1000;
const STAGES: Array<{ stage: OnboardingStage; days: number; column: 'onboardingNudge1SentAt' | 'onboardingNudge3SentAt' | 'onboardingNudge7SentAt' }> = [
  { stage: 7, days: 7, column: 'onboardingNudge7SentAt' },
  { stage: 3, days: 3, column: 'onboardingNudge3SentAt' },
  { stage: 1, days: 1, column: 'onboardingNudge1SentAt' },
];

/**
 * Hourly: at most one onboarding email per member per run, for the latest stage that is due.
 * Sending (or deciding there is nothing to say) stamps that stage and every earlier one, so
 * stages are never sent late. Members older than 14 days are never swept, which also keeps the
 * first deploy from emailing established members.
 */
@Injectable()
export class OnboardingNudgeEmailCron {
  private readonly logger = new Logger(OnboardingNudgeEmailCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Cron('41 * * * *')
  async tick(): Promise<void> {
    if (!this.appConfig.runSchedulers() || !this.appConfig.email()) return;
    try {
      await this.run(new Date());
    } catch (err) {
      this.logger.error(`[onboarding-nudge] run failed: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  async run(now: Date): Promise<number> {
    const baseUrl = (this.appConfig.frontendBaseUrl() ?? '').trim().replace(/\/$/, '') || 'https://menofhunger.com';
    const settingsUrl = `${baseUrl}/settings/notifications`;
    const due = new Date(now.getTime() - DAY_MS);
    const lookback = new Date(now.getTime() - 14 * DAY_MS);
    let sent = 0;

    let cursor: string | null = null;
    for (;;) {
      const users: Array<{
        id: string;
        email: string | null;
        emailVerifiedAt: Date | null;
        username: string | null;
        name: string | null;
        createdAt: Date;
        verifiedStatus: string;
        premium: boolean;
        longestStreakDays: number;
        recruitedById: string | null;
        onboardingNudge1SentAt: Date | null;
        onboardingNudge3SentAt: Date | null;
        onboardingNudge7SentAt: Date | null;
        notificationPreferences: { emailOnboarding: boolean } | null;
        _count: { posts: number; recruits: number };
      }> = await this.prisma.user.findMany({
        where: {
          ...NOT_BANNED_USER_WHERE,
          isBot: false,
          email: { not: null },
          emailVerifiedAt: { not: null },
          createdAt: { lte: due, gte: lookback },
          OR: [
            { onboardingNudge1SentAt: null },
            { onboardingNudge3SentAt: null, createdAt: { lte: new Date(now.getTime() - 3 * DAY_MS) } },
            { onboardingNudge7SentAt: null, createdAt: { lte: new Date(now.getTime() - 7 * DAY_MS) } },
          ],
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 200,
        select: {
          id: true,
          email: true,
          emailVerifiedAt: true,
          username: true,
          name: true,
          createdAt: true,
          verifiedStatus: true,
          premium: true,
          longestStreakDays: true,
          recruitedById: true,
          onboardingNudge1SentAt: true,
          onboardingNudge3SentAt: true,
          onboardingNudge7SentAt: true,
          notificationPreferences: { select: { emailOnboarding: true } },
          _count: { select: { posts: { where: { ...NOT_DELETED, isDraft: false } }, recruits: true } },
        },
      });
      if (users.length === 0) break;
      cursor = users[users.length - 1]!.id;

      for (const u of users) {
        const ageMs = now.getTime() - u.createdAt.getTime();
        const target = STAGES.find((s) => ageMs >= s.days * DAY_MS && !u[s.column]);
        if (!target) continue;

        const stamp = STAGES.filter((s) => s.days <= target.days).reduce(
          (acc, s) => ({ ...acc, [s.column]: now }),
          {} as Record<string, Date>,
        );
        const to = getVerifiedRecipientEmail(u);
        const optedOut = u.notificationPreferences?.emailOnboarding === false;
        const nudge = pickOnboardingNudge(target.stage, {
          verified: u.verifiedStatus !== 'none' || u.premium,
          hasPosted: u._count.posts > 0,
          hasCheckedIn: u.longestStreakDays > 0,
          hasInvited: u._count.recruits > 0,
        });
        if (!to || optedOut || !nudge) {
          await this.prisma.user.update({ where: { id: u.id }, data: stamp });
          continue;
        }

        const { subject, text, html } = buildOnboardingNudgeEmail({
          greeting: buildGreeting({ name: u.name, username: u.username, tone: 'hey' }),
          nudge,
          baseUrl,
          settingsUrl,
        });
        const res = await this.email.sendText({ to, subject, text, html, category: 'engagement', userId: u.id });
        if (res.sent) {
          await this.prisma.user.update({ where: { id: u.id }, data: stamp });
          sent += 1;
        } else {
          this.logger.debug(`[onboarding-nudge] not sent userId=${u.id} reason=${res.reason ?? 'unknown'}`);
        }
      }
    }
    return sent;
  }
}
