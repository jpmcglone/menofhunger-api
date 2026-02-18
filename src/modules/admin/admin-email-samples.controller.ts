import { BadRequestException, Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AdminGuard, type AdminRequest } from './admin.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { EmailService } from '../email/email.service';
import { escapeHtml, renderButton, renderCard, renderMohEmail, renderPill } from '../email/templates/moh-email';
import { DailyContentService } from '../daily-content/daily-content.service';

function safeBaseUrl(raw: string | null): string {
  const base = (raw ?? '').trim() || 'https://menofhunger.com';
  return base.replace(/\/$/, '');
}

const schema = z.object({
  type: z.enum(['daily_digest', 'new_notifications', 'instant_high_signal', 'streak_reminder']),
});

type SampleType = z.infer<typeof schema>['type'];

@UseGuards(AdminGuard)
@Controller('admin/email-samples')
export class AdminEmailSamplesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly email: EmailService,
    private readonly dailyContent: DailyContentService,
  ) {}

  @Post('send')
  async sendSample(
    @Res({ passthrough: true }) res: Response,
    @Req() req: AdminRequest,
    @Body() body: unknown,
  ) {
    res.setHeader('Cache-Control', 'no-store');

    const emailCfg = this.appConfig.email();
    if (!emailCfg) {
      throw new BadRequestException('Email is not configured.');
    }

    const adminId = req.user?.id ?? '';
    if (!adminId) throw new BadRequestException('Missing admin user.');

    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { id: true, email: true, emailVerifiedAt: true, name: true, username: true },
    });
    if (!admin) throw new BadRequestException('Admin user not found.');
    const to = (admin.email ?? '').trim();
    if (!to) throw new BadRequestException('Your account has no email set.');
    if (!admin.emailVerifiedAt) throw new BadRequestException('Your email must be verified to send samples.');

    const parsed = schema.parse(body ?? {});
    const baseUrl = safeBaseUrl(this.appConfig.frontendBaseUrl());
    const greetingName = (admin.name ?? admin.username ?? '').trim();
    const greeting = greetingName ? `Hey ${greetingName},` : 'Hey,';

    const sample = await this.renderSample(parsed.type, { baseUrl, greeting });
    const from = emailCfg.fromEmail.notifications || emailCfg.fromEmail.default;
    const sent = await this.email.sendText({ to, from, subject: sample.subject, text: sample.text, html: sample.html });

    return { data: { sent: sent.sent, reason: sent.reason ?? null, type: parsed.type } };
  }

  private async renderSample(
    type: SampleType,
    ctx: { baseUrl: string; greeting: string },
  ): Promise<{ subject: string; text: string; html: string }> {
    if (type === 'daily_digest') return await this.renderDailyDigestSample(ctx);
    if (type === 'new_notifications') return this.renderNewNotificationsSample(ctx);
    if (type === 'instant_high_signal') return this.renderInstantHighSignalSample(ctx);
    return this.renderStreakReminderSample(ctx);
  }

  private async renderDailyDigestSample(ctx: { baseUrl: string; greeting: string }) {
    const notificationsUrl = `${ctx.baseUrl}/notifications`;
    const messagesUrl = `${ctx.baseUrl}/chat`;
    const settingsUrl = `${ctx.baseUrl}/settings/notifications`;
    const homeUrl = `${ctx.baseUrl}/home`;

    const snap = await this.dailyContent.getToday().catch(() => null);
    const quoteText = (snap?.quote?.text ?? '').trim();
    const quoteAttr = snap?.quote
      ? snap.quote.kind === 'scripture'
        ? [snap.quote.reference, snap.quote.tradition].filter(Boolean).join(' · ')
        : (snap.quote.author ?? '').trim()
      : '';
    const w = snap?.websters1828 ?? null;
    const word = (w?.word ?? '').trim();
    const definition = (w?.definition ?? '').trim();
    const dictionaryUrl = (w?.dictionaryUrl ?? '').trim();

    const subject = 'Sample — Daily digest';
    const text = [
      `${ctx.greeting}`,
      '',
      'This is a sample of the Daily digest email.',
      '',
      `Notifications: ${notificationsUrl}`,
      `Messages: ${messagesUrl}`,
      '',
      'Definition of the day',
      word ? word : '(unavailable)',
      definition ? definition : '',
      dictionaryUrl ? `Source: ${dictionaryUrl}` : '',
      '',
      'Quote of the day',
      quoteText ? `“${quoteText}”` : '(unavailable)',
      quoteAttr ? `— ${quoteAttr}` : '',
      '',
      `Open: ${homeUrl}`,
      '',
      `Manage notification settings: ${settingsUrl}`,
    ]
      .filter(Boolean)
      .join('\n');

    const definitionBlock = word && definition
      ? renderCard(
          [
            `<div style="margin-bottom:10px;">${renderPill('Definition of the day', 'neutral')}</div>`,
            `<div style="font-size:14px;line-height:1.8;color:#111827;"><strong style="letter-spacing:0.06em;">${escapeHtml(
              word.toUpperCase(),
            )}</strong> — ${escapeHtml(definition).replace(/\n/g, '<br/>')}</div>`,
            dictionaryUrl
              ? `<div style="margin-top:10px;font-size:13px;line-height:1.7;color:#6b7280;">Source: <a href="${escapeHtml(
                  dictionaryUrl,
                )}" style="color:#111827;text-decoration:underline;">Webster’s 1828</a></div>`
              : ``,
          ].join(''),
        )
      : renderCard(`<div>${renderPill('Definition of the day', 'neutral')}</div><div style="margin-top:10px;color:#6b7280;">(unavailable)</div>`);

    const quoteBlock = quoteText
      ? renderCard(
          [
            `<div style="margin-bottom:10px;">${renderPill('Quote of the day', 'info')}</div>`,
            `<div style="font-size:16px;line-height:1.7;color:#111827;">“${escapeHtml(quoteText)}”</div>`,
            quoteAttr ? `<div style="margin-top:10px;font-size:13px;line-height:1.7;color:#6b7280;">— ${escapeHtml(quoteAttr)}</div>` : ``,
          ].join(''),
        )
      : renderCard(`<div>${renderPill('Quote of the day', 'info')}</div><div style="margin-top:10px;color:#6b7280;">(unavailable)</div>`);

    const html = renderMohEmail({
      title: 'Sample — Daily digest',
      preheader: 'This is a sample of the Daily digest email.',
      contentHtml: [
        `<div style="font-size:20px;font-weight:900;line-height:1.25;margin:0 0 6px 0;color:#111827;">Daily digest (sample)</div>`,
        `<div style="margin:0 0 10px 0;font-size:14px;line-height:1.7;color:#374151;">${escapeHtml(ctx.greeting)}</div>`,
        `<div style="margin:0 0 14px 0;">${renderPill('Sample email', 'warning')}</div>`,
        `<div style="margin-top:6px;">${renderButton({ href: notificationsUrl, label: 'Notifications' })} <span style="display:inline-block;width:8px;"></span> ${renderButton({
          href: messagesUrl,
          label: 'Messages',
          variant: 'secondary',
        })}</div>`,
        `<div style="height:12px;"></div>`,
        definitionBlock,
        quoteBlock,
        renderCard(
          [
            `<div style="margin-bottom:10px;">${renderPill('Daily check-in', 'warning')}</div>`,
            `<div style="font-size:14px;line-height:1.8;color:#111827;">How are you doing today?</div>`,
            `<div style="margin-top:12px;">${renderButton({ href: homeUrl, label: 'Check in' })}</div>`,
          ].join(''),
        ),
        `<div style="margin-top:16px;font-size:13px;line-height:1.8;color:#6b7280;">Manage notification settings: <a href="${escapeHtml(
          settingsUrl,
        )}" style="color:#111827;text-decoration:underline;">${escapeHtml(settingsUrl)}</a></div>`,
      ].join(''),
      footerHtml: `Men of Hunger · Sample email`,
    });

    return { subject, text, html };
  }

  private renderNewNotificationsSample(ctx: { baseUrl: string; greeting: string }) {
    const notificationsUrl = `${ctx.baseUrl}/notifications`;
    const settingsUrl = `${ctx.baseUrl}/settings/notifications`;
    const undelivered = 3;
    const items = [
      { text: 'New follower — @someone followed you', href: notificationsUrl },
      { text: 'New reply — “Good post.”', href: `${ctx.baseUrl}/p/sample` },
      { text: 'New mention — “@you check this out”', href: `${ctx.baseUrl}/p/sample2` },
    ];

    const subject = `Sample — Unread notifications`;
    const text = [
      `${ctx.greeting}`,
      '',
      `This is a sample of the “unread notifications” email.`,
      '',
      `You have ${undelivered} new notifications on Men of Hunger.`,
      '',
      'Recent:',
      ...items.map((it) => `- ${it.text} (${it.href})`),
      '',
      `Open: ${notificationsUrl}`,
      '',
      `Manage email notification settings: ${settingsUrl}`,
    ].join('\n');

    const html = renderMohEmail({
      title: `Unread notifications (sample)`,
      preheader: `Sample: you have ${undelivered} new notifications.`,
      contentHtml: [
        `<div style="font-size:20px;font-weight:900;line-height:1.25;margin:0 0 6px 0;color:#111827;">You have ${undelivered} new notifications</div>`,
        `<div style="margin:0 0 10px 0;font-size:14px;line-height:1.7;color:#374151;">${escapeHtml(ctx.greeting)}</div>`,
        `<div style="margin-top:10px;display:block;">${renderButton({ href: notificationsUrl, label: 'Open notifications' })}</div>`,
        renderCard(
          [
            `<div style="font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">Recent</div>`,
            `<ul style="margin:10px 0 0 18px;padding:0;color:#111827;font-size:14px;line-height:1.6;">`,
            ...items.map(
              (it) =>
                `<li style="margin:0 0 8px 0;"><a href="${escapeHtml(it.href)}" style="color:#111827;text-decoration:none;">${escapeHtml(
                  it.text,
                )}</a></li>`,
            ),
            `</ul>`,
          ].join(''),
        ),
        `<div style="margin-top:14px;font-size:13px;line-height:1.7;color:#6b7280;">Manage email notification settings: <a href="${escapeHtml(
          settingsUrl,
        )}" style="color:#111827;text-decoration:underline;">Settings → Notifications</a></div>`,
      ].join(''),
      footerHtml: `Men of Hunger · Sample email`,
    });

    return { subject, text, html };
  }

  private renderInstantHighSignalSample(ctx: { baseUrl: string; greeting: string }) {
    const notificationsUrl = `${ctx.baseUrl}/notifications`;
    const chatUrl = `${ctx.baseUrl}/chat`;
    const settingsUrl = `${ctx.baseUrl}/settings/notifications`;

    const subject = 'Sample — New activity';
    const text = [
      `${ctx.greeting}`,
      '',
      `This is a sample of the “instant high-signal” email.`,
      '',
      `Open chat: ${chatUrl}`,
      `Open notifications: ${notificationsUrl}`,
      '',
      `Manage notification settings: ${settingsUrl}`,
    ].join('\n');

    const html = renderMohEmail({
      title: 'New activity (sample)',
      preheader: 'Sample: new messages and mentions waiting for you.',
      contentHtml: [
        `<div style="font-size:20px;font-weight:900;line-height:1.25;margin:0 0 6px 0;color:#111827;">New activity</div>`,
        `<div style="margin:0 0 10px 0;font-size:14px;line-height:1.7;color:#374151;">${escapeHtml(ctx.greeting)}</div>`,
        `<div style="margin:0 0 14px 0;">${renderPill('Sample email', 'warning')}</div>`,
        renderCard(
          [
            `<div style="margin-bottom:10px;">${renderPill('Messages', 'warning')}</div>`,
            `<div style="font-size:14px;line-height:1.8;color:#111827;">You have <strong>2</strong> unread messages.</div>`,
            `<ul style="margin:10px 0 0 18px;padding:0;color:#111827;font-size:14px;line-height:1.6;">`,
            `<li style="margin:0 0 8px 0;"><strong>John</strong> — “You free this week?”</li>`,
            `<li style="margin:0 0 8px 0;"><strong>Mike</strong> — “Good to see your check-in.”</li>`,
            `</ul>`,
            `<div style="margin-top:12px;">${renderButton({ href: chatUrl, label: 'Open chat' })}</div>`,
          ].join(''),
        ),
        renderCard(
          [
            `<div style="margin-bottom:10px;">${renderPill('Mentions & replies', 'info')}</div>`,
            `<ul style="margin:0 0 0 18px;padding:0;color:#111827;font-size:14px;line-height:1.6;">`,
            `<li style="margin:0 0 10px 0;"><strong>Mention</strong> from <strong>@someone</strong> — “@you what do you think?”</li>`,
            `<li style="margin:0 0 10px 0;"><strong>Reply</strong> from <strong>@another</strong> — “Strong point.”</li>`,
            `</ul>`,
            `<div style="margin-top:12px;">${renderButton({ href: notificationsUrl, label: 'Open notifications', variant: 'secondary' })}</div>`,
          ].join(''),
        ),
        `<div style="margin-top:14px;font-size:13px;line-height:1.8;color:#6b7280;">You can turn off instant emails in <a href="${escapeHtml(
          settingsUrl,
        )}" style="color:#111827;text-decoration:underline;">Settings → Notifications</a>.</div>`,
      ].join(''),
      footerHtml: `Men of Hunger · Sample email`,
    });

    return { subject, text, html };
  }

  private renderStreakReminderSample(ctx: { baseUrl: string; greeting: string }) {
    const homeUrl = `${ctx.baseUrl}/home`;
    const settingsUrl = `${ctx.baseUrl}/settings/notifications`;
    const currentStreak = 7;

    const subject = `Sample — Don’t lose your streak (${currentStreak} days)`;
    const text = [
      `${ctx.greeting}`,
      '',
      `This is a sample of the “streak reminder” email.`,
      '',
      `You’re on a ${currentStreak}-day streak.`,
      `Post or reply today to keep it.`,
      '',
      `Open: ${homeUrl}`,
      '',
      `Manage email notification settings: ${settingsUrl}`,
    ].join('\n');

    const html = renderMohEmail({
      title: `Keep your streak (sample)`,
      preheader: `Sample: post or reply today to keep your ${currentStreak}-day streak.`,
      contentHtml: [
        `<div style="font-size:20px;font-weight:900;line-height:1.25;margin:0 0 6px 0;color:#111827;">Keep your streak</div>`,
        `<div style="margin:0 0 10px 0;font-size:14px;line-height:1.7;color:#374151;">${escapeHtml(ctx.greeting)}</div>`,
        renderCard(
          [
            `<div style="margin-bottom:10px;">${renderPill('Streak reminder', 'warning')}</div>`,
            `<div style="font-size:14px;line-height:1.8;color:#111827;">You’re on a <strong>${currentStreak}</strong>-day streak.</div>`,
            `<div style="margin-top:10px;font-size:14px;line-height:1.8;color:#111827;">Post or reply <strong>today</strong> to keep it.</div>`,
            `<div style="margin-top:12px;">${renderButton({ href: homeUrl, label: 'Post now' })}</div>`,
          ].join(''),
        ),
        `<div style="margin-top:16px;font-size:13px;line-height:1.8;color:#6b7280;">Manage notification settings: <a href="${escapeHtml(
          settingsUrl,
        )}" style="color:#111827;text-decoration:underline;">${escapeHtml(settingsUrl)}</a></div>`,
      ].join(''),
      footerHtml: `Men of Hunger · Sample email`,
    });

    return { subject, text, html };
  }
}

