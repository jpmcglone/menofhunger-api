import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../modules/app/app-config.service';
import { describeMissingProfileFields, type MissingProfileField } from '../../modules/email/email-content';

type SlackBlock = Record<string, unknown>;

export interface SlackProfilePayload {
  userId: string;
  username: string | null;
  name: string | null;
  email: string | null;
  location: string | null;
  interests: string[];
  avatarUrl: string | null;
}

export interface SlackPremiumPayload {
  userId: string;
  username: string | null;
  name?: string | null;
  tier: 'premium' | 'premiumPlus';
  source: 'stripe' | 'admin';
}

export interface SlackReportPayload {
  targetType: 'post' | 'user';
  reason: string;
  details: string | null;
  reporterUserId: string;
}

export interface SlackVerificationPayload {
  userId: string;
  providerHint: string | null;
}

export interface SlackFeedbackPayload {
  category: string;
  subject: string;
  details: string;
  email: string | null;
  userId?: string | null;
}

export interface SlackProfileReminderPayload {
  userId: string;
  username: string | null;
  email: string | null;
  checkpoint: '24h' | '7d';
  missingFields: MissingProfileField[];
}

export interface SlackDailyDigestPayload {
  dateLabel: string;
  totalNewUserCount: number;
  newPostCount: number;
  activeUserCount: number;
  bannedUserCount: number;
  activePremiumCount: number;
  activePremiumPlusCount: number;
  newSubscriberCount: number;
  pendingCancellationCount: number;
  pendingReportCount: number;
  unreviewedFeedbackCount: number;
  pendingVerificationCount: number;
  topPost: {
    id: string;
    body: string;
    boostCount: number;
    commentCount: number;
    viewerCount: number;
    username: string | null;
  } | null;
  frontendBaseUrl: string | null;
}

@Injectable()
export class SlackService {
  private readonly logger = new Logger(SlackService.name);
  private readonly webhookUrl: string | null;
  private readonly baseUrl: string | null;

  constructor(appConfig: AppConfigService) {
    this.webhookUrl = appConfig.slackWebhookUrl();
    this.baseUrl = appConfig.frontendBaseUrl()?.replace(/\/$/, '') ?? null;
    if (this.webhookUrl) {
      this.logger.log('Slack notifications enabled.');
    } else {
      this.logger.log('Slack not configured — notifications disabled. Set SLACK_WEBHOOK_URL when ready.');
    }
  }

  get isConfigured(): boolean {
    return !!this.webhookUrl;
  }

  // ─── Event notifications ───────────────────────────────────────────────────

  notifySignup({ userId }: { userId: string }): void {
    const ts = this.formatTime(new Date());
    const adminLink = this.link(`/admin/users`, 'View in Admin →');

    void this.send(':wave: New sign-up', [
      this.section(':wave: *New Sign-Up*\nA new account was created.', this.button('View in Admin', `/admin/users`)),
      this.contextBlock(`\`${userId}\``, adminLink, ts),
    ]);
  }

  notifyProfileComplete({ userId, username, name, email, location, interests, avatarUrl }: SlackProfilePayload): void {
    const ts = this.formatTime(new Date());

    const headerSection: SlackBlock = {
      type: 'section',
      text: { type: 'mrkdwn', text: ':white_check_mark: *Profile Complete*' },
    };
    if (avatarUrl) {
      headerSection.accessory = { type: 'image', image_url: avatarUrl, alt_text: username ?? 'avatar' };
    }

    const fields: Array<[string, string]> = [
      ['Username', this.userReference(username)],
      ['Name', name || '—'],
    ];
    if (email) fields.push(['Email', email]);
    if (location) fields.push(['Location', location]);

    const blocks: SlackBlock[] = [
      headerSection,
      { type: 'divider' },
      this.fieldsSection(fields),
    ];

    if (interests.length > 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Interests*\n${interests.join(' · ')}` },
      });
    }

    const profileLink = username ? this.link(`/u/${username}`, 'View profile') : null;
    const adminLink = this.link(`/admin/users`, 'Admin');
    blocks.push(this.contextBlock(`\`${userId}\``, profileLink, adminLink, ts));

    void this.send(`Profile complete: @${username ?? userId}`, blocks);
  }

  notifyPremiumGranted({ userId, username, name, tier, source }: SlackPremiumPayload): void {
    const ts = this.formatTime(new Date());
    const tierLabel = tier === 'premiumPlus' ? 'Premium+' : 'Premium';
    const sourceLabel = source === 'stripe' ? 'via Stripe' : 'via Admin';
    const emoji = tier === 'premiumPlus' ? ':star2:' : ':star:';

    const profileLink = username ? this.link(`/u/${username}`, 'View profile') : null;
    const adminLink = this.link(`/admin/users`, 'Admin');

    void this.send(`${emoji} New ${tierLabel} subscriber`, [
      this.section(`${emoji} *New ${tierLabel} Subscriber*`, username ? this.button('View Profile', `/u/${username}`) : undefined),
      { type: 'divider' },
      this.fieldsSection([
        ['Username', this.userReference(username)],
        ['Name', name || '—'],
        ['Tier', tierLabel],
        ['Source', sourceLabel],
      ]),
      this.contextBlock(`\`${userId}\``, profileLink, adminLink, ts),
    ]);
  }

  notifyReportSubmitted({ targetType, reason, details, reporterUserId }: SlackReportPayload): void {
    const ts = this.formatTime(new Date());
    const targetLabel = targetType === 'post' ? 'Post' : 'User';
    const snippet = details ? this.truncate(details, 200) : '_(no details provided)_';
    const reviewLink = this.link(`/admin/reports`, 'Review Reports →');

    void this.send(':rotating_light: New report submitted', [
      this.section(':rotating_light: *New Report Submitted*', this.button('Review Reports', `/admin/reports`)),
      { type: 'divider' },
      this.fieldsSection([
        ['Target', targetLabel],
        ['Reason', reason],
      ]),
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Details*\n${snippet}` },
      },
      this.contextBlock(`Reporter: \`${reporterUserId}\``, reviewLink, ts),
    ]);
  }

  notifyVerificationRequested({ userId, providerHint }: SlackVerificationPayload): void {
    const ts = this.formatTime(new Date());
    const providerText = providerHint ? providerHint : '_not specified_';
    const reviewLink = this.link(`/admin/verification`, 'Review Requests →');

    void this.send(':shield: Verification request submitted', [
      this.section(':shield: *Verification Request Submitted*', this.button('Review Requests', `/admin/verification`)),
      this.fieldsSection([
        ['User ID', `\`${userId}\``],
        ['Provider hint', providerText],
      ]),
      this.contextBlock(reviewLink, ts),
    ]);
  }

  notifyFeedbackSubmitted({ category, subject, details, email, userId }: SlackFeedbackPayload): void {
    const ts = this.formatTime(new Date());
    const snippet = this.truncate(details, 300);
    const submitter = email ?? (userId ? `\`${userId}\`` : '_anonymous_');
    const reviewLink = this.link(`/admin/feedback`, 'Review Feedback →');

    void this.send(':speech_balloon: New feedback submitted', [
      this.section(':speech_balloon: *New Feedback Submitted*', this.button('Review Feedback', `/admin/feedback`)),
      { type: 'divider' },
      this.fieldsSection([
        ['Category', category],
        ['From', submitter],
      ]),
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*"${subject}"*\n${snippet}` },
      },
      this.contextBlock(reviewLink, ts),
    ]);
  }

  notifyProfileReminderSent({ userId, username, email, checkpoint, missingFields }: SlackProfileReminderPayload): void {
    const ts = this.formatTime(new Date());
    const checkpointLabel = checkpoint === '24h' ? '24-hour' : '7-day';
    const missingLabel = describeMissingProfileFields(missingFields);
    const profileLink = username ? this.link(`/u/${username}`, `@${username}`) : null;
    const adminLink = this.link(`/admin/users`, 'Admin');

    void this.send(`:envelope: Profile reminder sent (${checkpointLabel})`, [
      this.section(`:envelope: *Profile Reminder Sent (${checkpointLabel})*`),
      this.fieldsSection([
        ['User', profileLink ?? this.userReference(username, userId)],
        ['Email', email ?? '—'],
        ['Missing', missingLabel],
        ['Checkpoint', `${checkpointLabel} after signup`],
      ]),
      this.contextBlock(`\`${userId}\``, adminLink, ts),
    ]);
  }

  notifyDailyDigest(p: SlackDailyDigestPayload): void {
    const ts = this.formatTime(new Date());
    const base = (p.frontendBaseUrl ?? this.baseUrl)?.replace(/\/$/, '') ?? null;

    const blocks: SlackBlock[] = [];

    // Header
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:bar_chart: *Daily Digest — ${p.dateLabel}*` },
    });
    blocks.push({ type: 'divider' });

    // Yesterday's Activity
      blocks.push(this.section('*Yesterday\'s Activity*'));
    const activityFields: SlackBlock[] = [
      { type: 'mrkdwn', text: `*New Members*\n${base ? `<${base}/admin/users|${p.totalNewUserCount}>` : String(p.totalNewUserCount)}` },
      { type: 'mrkdwn', text: `*New Posts*\n${p.newPostCount}` },
      { type: 'mrkdwn', text: `*Active Users*\n${p.activeUserCount}` },
    ];
    if (p.bannedUserCount > 0) {
      activityFields.push({ type: 'mrkdwn', text: `*Users Banned*\n:rotating_light: ${p.bannedUserCount}` });
    }
    blocks.push(this.fieldsFromBlocks(activityFields));
    blocks.push({ type: 'divider' });

    // Revenue & Subscriptions
    blocks.push(this.section('*Revenue & Subscriptions*'));
    const revenueFields: SlackBlock[] = [
      { type: 'mrkdwn', text: `*Active Premium*\n${p.activePremiumCount}` },
      { type: 'mrkdwn', text: `*Active Premium+*\n${p.activePremiumPlusCount}` },
      {
        type: 'mrkdwn',
        text: `*New Subscribers*\n${p.newSubscriberCount > 0 ? `:tada: ${p.newSubscriberCount}` : '0'}`,
      },
    ];
    if (p.pendingCancellationCount > 0) {
      revenueFields.push({ type: 'mrkdwn', text: `*Cancelling*\n:warning: ${p.pendingCancellationCount}` });
    }
    blocks.push(this.fieldsFromBlocks(revenueFields));

    // Open Backlog
    const hasBacklog = p.pendingReportCount > 0 || p.unreviewedFeedbackCount > 0 || p.pendingVerificationCount > 0;
    if (hasBacklog) {
      blocks.push({ type: 'divider' });
      const backlogLines: string[] = [':warning: *Open Backlog*'];
      if (p.pendingReportCount > 0) {
        const n = p.pendingReportCount;
        backlogLines.push(`:red_circle: ${base ? `<${base}/admin/reports|${n} pending report${n !== 1 ? 's' : ''}>` : `${n} pending reports`}`);
      }
      if (p.unreviewedFeedbackCount > 0) {
        const n = p.unreviewedFeedbackCount;
        backlogLines.push(`:large_yellow_circle: ${base ? `<${base}/admin/feedback|${n} unreviewed feedback${n !== 1 ? 's' : ''}>` : `${n} unreviewed feedbacks`}`);
      }
      if (p.pendingVerificationCount > 0) {
        const n = p.pendingVerificationCount;
        backlogLines.push(`:large_blue_circle: ${base ? `<${base}/admin/verification|${n} pending verification${n !== 1 ? 's' : ''}>` : `${n} pending verifications`}`);
      }
      blocks.push(this.section(backlogLines.join('\n')));
    }

    // Top Post
    if (p.topPost) {
      blocks.push({ type: 'divider' });
      const postUrl = base ? `${base}/p/${p.topPost.id}` : null;
      const author = p.topPost.username
        ? (base ? `<${base}/u/${p.topPost.username}|@${p.topPost.username}>` : `@${p.topPost.username}`)
        : '_unknown_';
      const snippet = this.truncate(p.topPost.body, 220);
      const stats = `:repeat: ${p.topPost.boostCount} · :speech_balloon: ${p.topPost.commentCount} · :eye: ${p.topPost.viewerCount}`;
      const bodyText = [
        `:star: *Top Post of the Day*`,
        `by ${author}`,
        `_"${snippet}"_`,
        stats,
        ...(postUrl ? [`<${postUrl}|View post →>`] : []),
      ].join('\n');
      blocks.push(this.section(bodyText));
    }

    // Footer
    blocks.push(this.contextBlock(`Men of Hunger`, ts));

    void this.send(`Daily Digest — ${p.dateLabel}`, blocks);
  }

  // ─── Core send ─────────────────────────────────────────────────────────────

  async send(text: string, blocks?: SlackBlock[]): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      const body: Record<string, unknown> = { text };
      if (blocks?.length) body.blocks = blocks;
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const responseText = this.truncate(await res.text().catch(() => ''), 200);
        this.logger.warn(`Slack webhook returned ${res.status}${responseText ? `: ${responseText}` : ''}`);
      }
    } catch (err) {
      this.logger.warn(`Slack webhook failed: ${(err as Error)?.message}`);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Returns a mrkdwn link string, or null if baseUrl is not configured. */
  private link(path: string, label: string): string | null {
    if (!this.baseUrl) return null;
    return `<${this.baseUrl}${path}|${label}>`;
  }

  private section(text: string, accessory?: SlackBlock): SlackBlock {
    return {
      type: 'section',
      text: { type: 'mrkdwn', text },
      ...(accessory ? { accessory } : {}),
    };
  }

  private field(label: string, value: string): SlackBlock {
    return { type: 'mrkdwn', text: `*${label}*\n${value}` };
  }

  private fieldsSection(fields: Array<[label: string, value: string]>): SlackBlock {
    return { type: 'section', fields: fields.map(([label, value]) => this.field(label, value)) };
  }

  private fieldsFromBlocks(fields: SlackBlock[]): SlackBlock {
    return { type: 'section', fields };
  }

  private contextBlock(...parts: Array<string | null | undefined | false>): SlackBlock {
    return {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: parts.filter(Boolean).join(' · ') }],
    };
  }

  private userReference(username: string | null, fallbackUserId?: string): string {
    if (username) return this.link(`/u/${username}`, `@${username}`) ?? `@${username}`;
    return fallbackUserId ? `\`${fallbackUserId}\`` : '—';
  }

  /** Returns a Slack button accessory block, or undefined if baseUrl is not configured. */
  private button(label: string, path: string): SlackBlock | undefined {
    if (!this.baseUrl) return undefined;
    return {
      type: 'button',
      text: { type: 'plain_text', text: label, emoji: false },
      url: `${this.baseUrl}${path}`,
    };
  }

  private formatTime(date: Date): string {
    return (
      date.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        dateStyle: 'medium',
        timeStyle: 'short',
      }) + ' ET'
    );
  }

  private truncate(s: string, max: number): string {
    const t = (s ?? '').trim();
    if (t.length <= max) return t;
    return t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
  }
}
