import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { SlackService } from '../../common/slack/slack.service';
import { readUnansweredNewMemberPosts } from './admin-new-member-posts.read';
import { PostsReadService } from '../posts-read/posts-read.service';

const ALERT_KIND = 'newMemberPostAlert';
const NEW_MEMBER_DAYS = 7;
const MIN_AGE_MINUTES = 120;

/**
 * Every 30 minutes: a new member's first public voice should not sit unanswered.
 * Each post alerts once; `AdminEmailLog (kind, dayKey=postId)` is the unique claim.
 */
@Injectable()
export class AdminNewMemberPostsCron {
  private readonly logger = new Logger(AdminNewMemberPostsCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly slack: SlackService,
    private readonly postsRead: PostsReadService,
  ) {}

  @Cron('*/30 * * * *')
  async tick(): Promise<void> {
    if (!this.appConfig.runSchedulers() || !this.slack.isConfigured) return;
    try {
      await this.alertWaiting(new Date());
    } catch (err) {
      this.logger.error(`New-member reply check failed: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  async alertWaiting(now: Date): Promise<number> {
    const { posts } = await readUnansweredNewMemberPosts(
      this.postsRead.read,
      { newMemberDays: NEW_MEMBER_DAYS, minAgeMinutes: MIN_AGE_MINUTES, limit: 25 },
      now,
    );
    if (posts.length === 0) return 0;

    const already = await this.prisma.adminEmailLog.findMany({
      where: { kind: ALERT_KIND, dayKey: { in: posts.map((p) => p.id) } },
      select: { dayKey: true },
    });
    const seen = new Set(already.map((r) => r.dayKey));
    const claimed: typeof posts = [];
    for (const post of posts) {
      if (seen.has(post.id)) continue;
      try {
        await this.prisma.adminEmailLog.create({ data: { kind: ALERT_KIND, dayKey: post.id } });
        claimed.push(post);
      } catch {
        // Unique violation: another instance claimed it first.
      }
    }
    if (claimed.length === 0) return 0;

    this.slack.notifyNewMemberPostsWaiting({
      posts: claimed.map((p) => ({
        id: p.id,
        username: p.author.username,
        waitingMinutes: p.waitingMinutes,
        snippet: p.snippet,
      })),
    });
    return claimed.length;
  }
}
