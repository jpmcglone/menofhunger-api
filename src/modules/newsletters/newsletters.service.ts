import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Newsletter, NewsletterStatus, Prisma } from '@prisma/client';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import type {
  NewsletterAdminDto,
  NewsletterAudienceCountDto,
  NewsletterAudienceFilter,
  NewsletterPreviewDto,
} from '../../common/dto/newsletter.dto';
import { audienceFiltersWhere, parseAudienceFilters } from './newsletter-audience';
import { AppConfigService } from '../app/app-config.service';
import { EmailService } from '../email/email.service';
import { JOBS } from '../jobs/jobs.constants';
import { JobsService } from '../jobs/jobs.service';
import { NotificationPreferencesService } from '../notifications/notification-preferences.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  newsletterListId,
  oneClickUnsubscribeUrl,
} from './email-unsubscribe.helpers';
import { renderNewsletterEmail } from './newsletter-render';
import { issueNewsletterUnsubscribeToken, verifyNewsletterUnsubscribeToken } from './newsletter-unsubscribe-token';
import { varsForUser, type NewsletterVars } from './newsletter-vars';

export const NEWSLETTER_STARTER_BODY_JSON = JSON.stringify({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Hey {{firstName}},' }] },
    { type: 'paragraph' },
  ],
});

const PAGE_SIZE = 200;
const SEND_GAP_MS = 200;

export type NewsletterWriteInput = {
  subject?: string | null;
  preheader?: string | null;
  bodyJson?: string | null;
  ctaLabel?: string | null;
  ctaHref?: string | null;
  imageKey?: string | null;
  scheduledAt?: Date | null;
  audienceFilters?: NewsletterAudienceFilter[];
};

const SAMPLE_VARS: NewsletterVars = {
  firstName: 'James',
  name: 'James',
  username: 'james',
};

@Injectable()
export class NewslettersService {
  private readonly logger = new Logger(NewslettersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly email: EmailService,
    private readonly jobs: JobsService,
    private readonly prefs: NotificationPreferencesService,
  ) {}

  async listAdmin(): Promise<NewsletterAdminDto[]> {
    const rows = await this.prisma.newsletter.findMany({ orderBy: { createdAt: 'desc' } });
    const confirmedEmailCount = await this.countEligible([]);
    const eligibleCounts = await Promise.all(rows.map((row) => this.liveEligibleCount(row)));
    return rows.map((row, i) => this.toAdminDto(row, eligibleCounts[i] ?? 0, confirmedEmailCount));
  }

  async getAdmin(id: string): Promise<NewsletterAdminDto> {
    const row = await this.require(id);
    const [eligibleCount, confirmedEmailCount] = await Promise.all([
      this.liveEligibleCount(row),
      this.countEligible([]),
    ]);
    return this.toAdminDto(row, eligibleCount, confirmedEmailCount);
  }

  async countAudience(filters: NewsletterAudienceFilter[]): Promise<NewsletterAudienceCountDto> {
    const [eligibleCount, confirmedEmailCount] = await Promise.all([
      this.countEligible(filters),
      this.countEligible([]),
    ]);
    return { eligibleCount, confirmedEmailCount };
  }

  async create(adminUserId: string): Promise<NewsletterAdminDto> {
    const row = await this.prisma.newsletter.create({
      data: {
        createdByAdminId: adminUserId,
        bodyJson: NEWSLETTER_STARTER_BODY_JSON,
      },
    });
    return this.toAdminDto(row, await this.liveEligibleCount(row), await this.countEligible([]));
  }

  async update(id: string, input: NewsletterWriteInput): Promise<NewsletterAdminDto> {
    const row = await this.require(id);
    this.assertEditable(row);
    const data = this.writeData(input, row);
    const updated = await this.prisma.newsletter.update({ where: { id }, data });
    return this.toAdminDto(updated, await this.liveEligibleCount(updated), await this.countEligible([]));
  }

  async preview(input: {
    subject?: string | null;
    preheader?: string | null;
    bodyJson?: string | null;
    ctaLabel?: string | null;
    ctaHref?: string | null;
    imageKey?: string | null;
    vars?: NewsletterVars;
  }): Promise<NewsletterPreviewDto> {
    const rendered = this.renderFor({
      subject: input.subject ?? '',
      preheader: input.preheader ?? '',
      bodyJson: input.bodyJson ?? NEWSLETTER_STARTER_BODY_JSON,
      ctaLabel: input.ctaLabel ?? null,
      ctaHref: input.ctaHref ?? null,
      imageKey: input.imageKey ?? null,
      vars: input.vars ?? SAMPLE_VARS,
      userId: 'preview',
      allowMissingPostal: true,
    });
    return {
      subject: rendered.subject,
      preheader: rendered.preheader,
      html: rendered.html,
      text: rendered.text,
    };
  }

  async sendPreviewToAdmin(id: string, admin: {
    id: string;
    email: string | null;
    emailVerifiedAt: Date | null;
    name: string | null;
    username: string | null;
  }): Promise<{ sent: boolean; reason: string | null }> {
    const row = await this.require(id);
    const emailCfg = this.appConfig.email();
    if (!emailCfg) throw new BadRequestException('Email is not configured.');
    const to = (admin.email ?? '').trim();
    if (!to) throw new BadRequestException('Your account has no email set.');
    if (!admin.emailVerifiedAt) throw new BadRequestException('Your email must be verified to send a preview.');

    const rendered = this.renderFor({
      ...row,
      vars: varsForUser(admin),
      userId: admin.id,
      allowMissingPostal: true,
    });
    const from = this.newsletterFrom(emailCfg);
    const sent = await this.email.sendText({
      to,
      from,
      subject: `Preview — ${rendered.subject}`,
      text: rendered.text,
      html: rendered.html,
      replyTo: this.replyTo(emailCfg),
      headers: rendered.headers,
      category: 'broadcast',
      userId: admin.id,
    });
    if (!sent.sent) {
      throw new BadRequestException(previewSendFailureMessage(sent.reason));
    }
    return { sent: true, reason: null };
  }

  async schedule(id: string, scheduledAt: Date): Promise<NewsletterAdminDto> {
    this.assertPostalAddress();
    const row = await this.require(id);
    this.assertEditable(row);
    this.assertSendable(row);
    if (scheduledAt.getTime() <= Date.now()) {
      throw new BadRequestException('Schedule time must be in the future.');
    }
    const updated = await this.prisma.newsletter.update({
      where: { id },
      data: { status: 'scheduled', scheduledAt },
    });
    return this.toAdminDto(updated, await this.liveEligibleCount(updated), await this.countEligible([]));
  }

  async unschedule(id: string): Promise<NewsletterAdminDto> {
    const row = await this.require(id);
    if (row.status !== 'scheduled') throw new BadRequestException('Only scheduled newsletters can be unscheduled.');
    const updated = await this.prisma.newsletter.update({
      where: { id },
      data: { status: 'draft', scheduledAt: null },
    });
    return this.toAdminDto(updated, await this.liveEligibleCount(updated), await this.countEligible([]));
  }

  async sendNow(id: string): Promise<NewsletterAdminDto> {
    this.assertPostalAddress();
    const row = await this.require(id);
    this.assertEditable(row);
    this.assertSendable(row);
    const claimed = await this.claimForSend(id, ['draft', 'scheduled']);
    await this.enqueueSend(id);
    return this.toAdminDto(claimed, claimed.eligibleCount, await this.countEligible([]));
  }

  async duplicate(id: string, adminUserId: string): Promise<NewsletterAdminDto> {
    const row = await this.require(id);
    const copy = await this.prisma.newsletter.create({
      data: {
        createdByAdminId: adminUserId,
        subject: row.subject,
        preheader: row.preheader,
        bodyJson: row.bodyJson || NEWSLETTER_STARTER_BODY_JSON,
        ctaLabel: row.ctaLabel,
        ctaHref: row.ctaHref,
        imageKey: row.imageKey,
        imageUpdatedAt: row.imageUpdatedAt,
        audienceFilters: row.audienceFilters ?? [],
      },
    });
    return this.toAdminDto(copy, await this.liveEligibleCount(copy), await this.countEligible([]));
  }

  async unsubscribeWithToken(token: string): Promise<{ ok: boolean }> {
    const secret = this.appConfig.sessionHmacSecret();
    const parsed = verifyNewsletterUnsubscribeToken({ token, secret });
    if (!parsed) throw new BadRequestException('Unsubscribe link is invalid or expired.');
    await this.prefs.setEmailNewsletter(parsed.userId, false);
    return { ok: true };
  }

  async claimDueAndEnqueue(): Promise<void> {
    const now = new Date();
    const due = await this.prisma.newsletter.findMany({
      where: { status: 'scheduled', scheduledAt: { lte: now } },
      select: { id: true },
      take: 20,
    });
    for (const row of due) {
      try {
        await this.claimForSend(row.id, ['scheduled']);
        await this.enqueueSend(row.id);
      } catch (err) {
        this.logger.warn(`Newsletter claim skipped ${row.id}: ${(err as Error).message}`);
      }
    }

    const remaining = await this.email.broadcastRemaining();
    if (remaining <= 0) return;

    const paused = await this.prisma.newsletter.findMany({
      where: { status: 'sending' },
      select: { id: true },
      take: 20,
    });
    for (const row of paused) {
      await this.enqueueSend(row.id);
    }
  }

  async runSend(newsletterId: string): Promise<{ done: boolean; paused: boolean }> {
    const row = await this.prisma.newsletter.findUnique({ where: { id: newsletterId } });
    if (!row || row.status !== 'sending') return { done: false, paused: false };

    let lastUserId = row.lastUserId;
    let sentCount = row.sentCount;
    let failedCount = row.failedCount;
    const emailCfg = this.appConfig.email();
    if (!emailCfg) {
      this.logger.warn(`Newsletter ${newsletterId} paused: email not configured`);
      return { done: false, paused: true };
    }

    for (;;) {
      if ((await this.email.broadcastRemaining()) <= 0) {
        await this.persistProgress(newsletterId, { lastUserId, sentCount, failedCount });
        return { done: false, paused: true };
      }

      const recipients = await this.prisma.user.findMany({
        where: {
          ...this.eligibleWhere(this.filtersOf(row)),
          ...(lastUserId ? { id: { gt: lastUserId } } : {}),
        },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        select: { id: true, email: true, emailVerifiedAt: true, name: true, username: true },
      });

      if (recipients.length === 0) {
        await this.prisma.newsletter.update({
          where: { id: newsletterId },
          data: {
            status: 'sent',
            sentAt: new Date(),
            lastUserId,
            sentCount,
            failedCount,
          },
        });
        return { done: true, paused: false };
      }

      for (const user of recipients) {
        if ((await this.email.broadcastRemaining()) <= 0) {
          await this.persistProgress(newsletterId, { lastUserId, sentCount, failedCount });
          return { done: false, paused: true };
        }
        const to = (user.email ?? '').trim();
        if (!to || !user.emailVerifiedAt) {
          lastUserId = user.id;
          continue;
        }
        const rendered = this.renderFor({
          ...row,
          vars: varsForUser(user),
          userId: user.id,
        });
        const sent = await this.email.sendText({
          to,
          from: this.newsletterFrom(emailCfg),
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          replyTo: this.replyTo(emailCfg),
          headers: rendered.headers,
          category: 'broadcast',
          userId: user.id,
        });
        if (sent.sent) sentCount += 1;
        else failedCount += 1;
        lastUserId = user.id;
        await sleep(SEND_GAP_MS);
      }

      await this.persistProgress(newsletterId, { lastUserId, sentCount, failedCount });
    }
  }

  async countEligible(filters: NewsletterAudienceFilter[] = []): Promise<number> {
    return this.prisma.user.count({ where: this.eligibleWhere(filters) });
  }

  eligibleWhere(filters: NewsletterAudienceFilter[] = [], now = new Date()): Prisma.UserWhereInput {
    const prefsOr: Prisma.UserWhereInput[] = [
      { notificationPreferences: { is: null } },
      { notificationPreferences: { is: { emailNewsletter: true } } },
    ];
    return {
      email: { not: null },
      emailVerifiedAt: { not: null },
      bannedAt: null,
      isBot: false,
      AND: [{ OR: prefsOr }, ...audienceFiltersWhere(filters, now)],
    };
  }

  private filtersOf(row: Newsletter): NewsletterAudienceFilter[] {
    return parseAudienceFilters(row.audienceFilters);
  }

  private async liveEligibleCount(row: Newsletter): Promise<number> {
    if (row.status === 'sending' || row.status === 'sent') return row.eligibleCount;
    return this.countEligible(this.filtersOf(row));
  }

  private async claimForSend(id: string, from: NewsletterStatus[]): Promise<Newsletter> {
    const current = await this.require(id);
    const eligibleCount = await this.countEligible(this.filtersOf(current));
    const claimed = await this.prisma.newsletter.updateMany({
      where: { id, status: { in: from } },
      data: {
        status: 'sending',
        scheduledAt: null,
        eligibleCount,
        sentCount: 0,
        failedCount: 0,
        lastUserId: null,
        sentAt: null,
      },
    });
    if (claimed.count === 0) {
      const current = await this.prisma.newsletter.findUnique({ where: { id } });
      if (current?.status === 'sending') return current;
      throw new BadRequestException('This newsletter cannot be sent.');
    }
    return this.require(id);
  }

  private async enqueueSend(id: string): Promise<void> {
    try {
      await this.jobs.enqueueCron(JOBS.newslettersSend, { newsletterId: id }, `newsletters-send-${id}`, {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
      });
    } catch (err) {
      this.logger.debug(`Newsletter send enqueue skipped ${id}: ${(err as Error).message}`);
    }
  }

  private async persistProgress(
    id: string,
    progress: { lastUserId: string | null; sentCount: number; failedCount: number },
  ): Promise<void> {
    await this.prisma.newsletter.update({
      where: { id },
      data: {
        lastUserId: progress.lastUserId,
        sentCount: progress.sentCount,
        failedCount: progress.failedCount,
      },
    });
  }

  private renderFor(row: {
    subject: string;
    preheader: string;
    bodyJson: string;
    ctaLabel: string | null;
    ctaHref: string | null;
    imageKey: string | null;
    vars: NewsletterVars;
    userId: string;
    allowMissingPostal?: boolean;
  }) {
    const postal = row.allowMissingPostal
      ? this.appConfig.newsletterPostalAddress() || 'Men of Hunger'
      : this.assertPostalAddress();
    const baseUrl = frontendBase(this.appConfig.frontendBaseUrl());
    const token = issueNewsletterUnsubscribeToken({
      userId: row.userId,
      secret: this.appConfig.sessionHmacSecret(),
    });
    const unsubscribeUrl = `${baseUrl}/email/unsubscribe?token=${encodeURIComponent(token)}`;
    const oneClickUrl = oneClickUnsubscribeUrl(this.appConfig.browserHandoffBaseUrl(), token);
    const rendered = renderNewsletterEmail({
      subject: row.subject,
      preheader: row.preheader,
      bodyJson: row.bodyJson,
      ctaLabel: row.ctaLabel,
      ctaHref: this.resolveCtaHref(row.ctaHref, baseUrl),
      heroImageUrl: publicAssetUrl({
        publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
        key: row.imageKey,
      }),
      vars: row.vars,
      unsubscribeUrl,
      settingsUrl: `${baseUrl}/settings/notifications`,
      siteUrl: baseUrl,
      postalAddress: postal,
    });
    return {
      ...rendered,
      headers: {
        'List-Unsubscribe': `<${oneClickUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'List-Id': newsletterListId(baseUrl),
      },
    };
  }

  private newsletterFrom(emailCfg: NonNullable<ReturnType<AppConfigService['email']>>): string {
    return emailCfg.fromEmail.newsletter || emailCfg.fromEmail.notifications || emailCfg.fromEmail.default;
  }

  private resolveCtaHref(href: string | null, baseUrl: string): string | null {
    const raw = (href ?? '').trim();
    if (!raw) return null;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    if (raw.startsWith('/')) return `${baseUrl}${raw}`;
    return raw;
  }

  private replyTo(emailCfg: NonNullable<ReturnType<AppConfigService['email']>>): string | undefined {
    const support = emailCfg.fromEmail.support?.trim();
    return support || undefined;
  }

  private assertPostalAddress(): string {
    const postal = this.appConfig.newsletterPostalAddress();
    if (!postal) {
      throw new BadRequestException('Set NEWSLETTER_POSTAL_ADDRESS before sending a newsletter.');
    }
    return postal;
  }

  private assertEditable(row: Newsletter): void {
    if (row.status === 'sending' || row.status === 'sent') {
      throw new BadRequestException('Sent newsletters cannot be edited.');
    }
  }

  private assertSendable(row: Newsletter): void {
    if (!row.subject.trim()) throw new BadRequestException('Add a subject before sending.');
    if (!row.bodyJson.trim()) throw new BadRequestException('Add a body before sending.');
  }

  private writeData(input: NewsletterWriteInput, current: Newsletter): Prisma.NewsletterUpdateInput {
    const data: Prisma.NewsletterUpdateInput = {};
    if (input.subject !== undefined) data.subject = (input.subject ?? '').trim();
    if (input.preheader !== undefined) data.preheader = (input.preheader ?? '').trim();
    if (input.bodyJson !== undefined) data.bodyJson = input.bodyJson ?? NEWSLETTER_STARTER_BODY_JSON;
    if (input.ctaLabel !== undefined) data.ctaLabel = emptyToNull(input.ctaLabel);
    if (input.ctaHref !== undefined) data.ctaHref = emptyToNull(input.ctaHref);
    if (input.imageKey !== undefined) {
      data.imageKey = emptyToNull(input.imageKey);
      data.imageUpdatedAt = input.imageKey ? new Date() : null;
    }
    if (input.scheduledAt !== undefined && current.status !== 'sending' && current.status !== 'sent') {
      data.scheduledAt = input.scheduledAt;
    }
    if (input.audienceFilters !== undefined) data.audienceFilters = input.audienceFilters;
    return data;
  }

  private async require(id: string): Promise<Newsletter> {
    const row = await this.prisma.newsletter.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Newsletter not found.');
    return row;
  }

  private toAdminDto(
    row: Newsletter,
    eligibleCount: number,
    confirmedEmailCount: number,
  ): NewsletterAdminDto {
    return {
      id: row.id,
      status: row.status,
      subject: row.subject,
      preheader: row.preheader,
      bodyJson: row.bodyJson,
      ctaLabel: row.ctaLabel,
      ctaHref: row.ctaHref,
      imageKey: row.imageKey,
      imageUrl: publicAssetUrl({
        publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
        key: row.imageKey,
        updatedAt: row.imageUpdatedAt,
      }),
      scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      audienceFilters: this.filtersOf(row),
      confirmedEmailCount,
      eligibleCount,
      sentCount: row.sentCount,
      failedCount: row.failedCount,
    };
  }
}

function previewSendFailureMessage(reason?: string | null): string {
  switch (reason) {
    case 'email_not_configured':
      return 'Email is not configured on this server.';
    case 'email_provider_not_supported':
      return 'Email provider is not supported.';
    case 'email_invalid':
      return 'Could not send that preview.';
    case 'resend_failed':
    case 'email_failed':
      return 'The email provider rejected the send. Try again.';
    case 'email_quota_hard_limit':
    case 'email_quota_broadcast_limit':
    case 'email_quota_engagement_limit':
    case 'email_quota_exceeded':
      return 'Daily email quota is exhausted. Try again tomorrow.';
    case 'email_per_user_engagement_cap':
      return 'You have hit the per-user email cap. Try again later.';
    default:
      return 'Could not send the preview.';
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : null;
}

function frontendBase(raw: string | null): string {
  return ((raw ?? '').trim() || 'https://menofhunger.com').replace(/\/$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
