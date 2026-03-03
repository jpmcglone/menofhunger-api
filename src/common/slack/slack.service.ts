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

  notifySignup({ userId }: { userId: string }): void {
    const ts = this.formatTime(new Date());
    void this.send(':wave: New sign-up', [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':wave: *New Sign-Up*\nA new account was created.',
        },
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

  private formatTime(date: Date): string {
    return date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      dateStyle: 'medium',
      timeStyle: 'short',
    }) + ' ET';
  }
}
