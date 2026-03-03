import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../modules/app/app-config.service';

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

  constructor(appConfig: AppConfigService) {
    this.webhookUrl = appConfig.slackWebhookUrl();
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
    void this.send(':wave: New sign-up', [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: ':wave: *New Sign-Up*\nA new account was created.' },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `\`${userId}\` · ${ts}` }],
      },
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

    const fields: SlackBlock[] = [
      { type: 'mrkdwn', text: `*Username*\n@${username ?? '—'}` },
      { type: 'mrkdwn', text: `*Name*\n${name || '—'}` },
    ];
    if (email) fields.push({ type: 'mrkdwn', text: `*Email*\n${email}` });
    if (location) fields.push({ type: 'mrkdwn', text: `*Location*\n${location}` });

    const blocks: SlackBlock[] = [
      headerSection,
      { type: 'divider' },
      { type: 'section', fields },
    ];

    if (interests.length > 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Interests*\n${interests.join(' · ')}` },
      });
    }

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `\`${userId}\` · ${ts}` }],
    });

    void this.send(`Profile complete: @${username ?? userId}`, blocks);
  }

  notifyPremiumGranted({ userId, username, name, tier, source }: SlackPremiumPayload): void {
    const ts = this.formatTime(new Date());
    const tierLabel = tier === 'premiumPlus' ? 'Premium+' : 'Premium';
    const sourceLabel = source === 'stripe' ? 'via Stripe' : 'via Admin';
    const emoji = tier === 'premiumPlus' ? ':star2:' : ':star:';

    void this.send(`${emoji} New ${tierLabel} subscriber`, [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `${emoji} *New ${tierLabel} Subscriber*` },
      },
      { type: 'divider' },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Username*\n${username ? `@${username}` : '—'}` },
          { type: 'mrkdwn', text: `*Name*\n${name || '—'}` },
          { type: 'mrkdwn', text: `*Tier*\n${tierLabel}` },
          { type: 'mrkdwn', text: `*Source*\n${sourceLabel}` },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `\`${userId}\` · ${ts}` }],
      },
    ]);
  }

  notifyReportSubmitted({ targetType, reason, details, reporterUserId }: SlackReportPayload): void {
    const ts = this.formatTime(new Date());
    const targetLabel = targetType === 'post' ? 'Post' : 'User';
    const snippet = details ? this.truncate(details, 200) : '_(no details provided)_';

    void this.send(':rotating_light: New report submitted', [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: ':rotating_light: *New Report Submitted*' },
      },
      { type: 'divider' },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Target*\n${targetLabel}` },
          { type: 'mrkdwn', text: `*Reason*\n${reason}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Details*\n${snippet}` },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Reporter: \`${reporterUserId}\` · ${ts}` }],
      },
    ]);
  }

  notifyVerificationRequested({ userId, providerHint }: SlackVerificationPayload): void {
    const ts = this.formatTime(new Date());
    const providerText = providerHint ? providerHint : '_not specified_';

    void this.send(':shield: Verification request submitted', [
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: ':shield: *Verification Request*' },
          { type: 'mrkdwn', text: `*Provider hint*\n${providerText}` },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `User: \`${userId}\` · ${ts}` }],
      },
    ]);
  }

  notifyFeedbackSubmitted({ category, subject, details, email, userId }: SlackFeedbackPayload): void {
    const ts = this.formatTime(new Date());
    const snippet = this.truncate(details, 300);
    const submitter = email ?? (userId ? `\`${userId}\`` : '_anonymous_');

    void this.send(':speech_balloon: New feedback submitted', [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: ':speech_balloon: *New Feedback Submitted*' },
      },
      { type: 'divider' },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Category*\n${category}` },
          { type: 'mrkdwn', text: `*From*\n${submitter}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*"${subject}"*\n${snippet}` },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: ts }],
      },
    ]);
  }

  notifyDailyDigest(p: SlackDailyDigestPayload): void {
    const ts = this.formatTime(new Date());
    const base = p.frontendBaseUrl?.replace(/\/$/, '') ?? null;

    const blocks: SlackBlock[] = [];

    // Header
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:bar_chart: *Daily Digest — ${p.dateLabel}*` },
    });
    blocks.push({ type: 'divider' });

    // Yesterday's Activity
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Yesterday\'s Activity*' },
    });
    const activityFields: SlackBlock[] = [
      { type: 'mrkdwn', text: `*New Members*\n${p.totalNewUserCount}` },
      { type: 'mrkdwn', text: `*New Posts*\n${p.newPostCount}` },
      { type: 'mrkdwn', text: `*Active Users*\n${p.activeUserCount}` },
    ];
    if (p.bannedUserCount > 0) {
      activityFields.push({ type: 'mrkdwn', text: `*Users Banned*\n:rotating_light: ${p.bannedUserCount}` });
    }
    blocks.push({ type: 'section', fields: activityFields });
    blocks.push({ type: 'divider' });

    // Revenue & Subscriptions
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Revenue & Subscriptions*' },
    });
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
    blocks.push({ type: 'section', fields: revenueFields });

    // Open Backlog
    const hasBacklog = p.pendingReportCount > 0 || p.unreviewedFeedbackCount > 0 || p.pendingVerificationCount > 0;
    if (hasBacklog) {
      blocks.push({ type: 'divider' });
      const backlogLines: string[] = [':warning: *Open Backlog*'];
      if (p.pendingReportCount > 0) {
        const link = base ? `<${base}/admin/reports|${p.pendingReportCount} pending report${p.pendingReportCount !== 1 ? 's' : ''}>` : `${p.pendingReportCount} pending reports`;
        backlogLines.push(`:red_circle: ${link}`);
      }
      if (p.unreviewedFeedbackCount > 0) {
        const link = base ? `<${base}/admin/feedback|${p.unreviewedFeedbackCount} unreviewed feedback${p.unreviewedFeedbackCount !== 1 ? 's' : ''}>` : `${p.unreviewedFeedbackCount} unreviewed feedbacks`;
        backlogLines.push(`:large_yellow_circle: ${link}`);
      }
      if (p.pendingVerificationCount > 0) {
        const link = base ? `<${base}/admin/verification|${p.pendingVerificationCount} pending verification${p.pendingVerificationCount !== 1 ? 's' : ''}>` : `${p.pendingVerificationCount} pending verifications`;
        backlogLines.push(`:large_blue_circle: ${link}`);
      }
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: backlogLines.join('\n') },
      });
    }

    // Top Post
    if (p.topPost) {
      blocks.push({ type: 'divider' });
      const postUrl = base ? `${base}/p/${p.topPost.id}` : null;
      const author = p.topPost.username ? `@${p.topPost.username}` : '_unknown_';
      const snippet = this.truncate(p.topPost.body, 220);
      const stats = `:repeat: ${p.topPost.boostCount} · :speech_balloon: ${p.topPost.commentCount} · :eye: ${p.topPost.viewerCount}`;
      const bodyText = [
        `:star: *Top Post of the Day*`,
        `by ${author}`,
        `_"${snippet}"_`,
        stats,
        ...(postUrl ? [`<${postUrl}|View post →>`] : []),
      ].join('\n');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: bodyText } });
    }

    // Footer
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Men of Hunger · ${ts}` }],
    });

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
        this.logger.warn(`Slack webhook returned ${res.status}`);
      }
    } catch (err) {
      this.logger.warn(`Slack webhook failed: ${(err as Error)?.message}`);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

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
