import { Injectable, Logger } from '@nestjs/common';
import type { ReportReason } from '@prisma/client';
import OpenAI from 'openai';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

import { PostsReadService } from '../posts-read/posts-read.service';
const NEW_ACCOUNT_DAYS = 14;
const NEW_AUTHOR_POST_COUNT = 5;
const MIN_BODY_CHARS = 8;
const FLAG_SCORE = 0.7;
const SELF_HARM_SCORE = 0.5;
const LINK = /https?:\/\/|www\./i;

type Scores = Record<string, number>;

/**
 * Screens a small slice of public posts with OpenAI's moderation endpoint, which is free.
 *
 * Members are phone-verified, so serious abuse is rare; spending a call on every post would be
 * waste. Only posts from new accounts, from authors with a short history, or carrying a link are
 * checked. Group, private, and draft posts are never sent anywhere. A hit becomes an ordinary
 * pending report in the admin queue, filed by the system reporter, and never hides anything.
 */
@Injectable()
export class ContentScreenService {
  private readonly logger = new Logger(ContentScreenService.name);
  private client: OpenAI | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly postsRead: PostsReadService,
  ) {}

  async screenPost(postId: string, systemReporterUserId: string | null): Promise<'skipped' | 'clean' | 'flagged' | 'failed'> {
    const cfg = this.config.contentScreen();
    if (!cfg.enabled || !systemReporterUserId) return 'skipped';
    const post = await this.postsRead.read.findFirst({
      where: { id: postId, deletedAt: null, isDraft: false, kind: { not: 'repost' }, communityGroupId: null, visibility: { not: 'onlyMe' } },
      select: { id: true, body: true, userId: true, user: { select: { createdAt: true, isBot: true } } },
    });
    const body = (post?.body ?? '').trim();
    if (!post || post.user.isBot || body.length < MIN_BODY_CHARS) return 'skipped';
    if (post.userId === systemReporterUserId) return 'skipped';
    if (!(await this.worthScreening(post.userId, post.user.createdAt, body))) return 'skipped';

    const scores = await this.moderate(cfg.apiKey, body.slice(0, 4000));
    if (!scores) return 'failed';
    const hit = classify(scores);
    if (!hit) return 'clean';

    const existing = await this.prisma.report.findFirst({
      where: { subjectPostId: post.id, reporterUserId: systemReporterUserId },
      select: { id: true },
    });
    if (existing) return 'flagged';
    await this.prisma.report.create({
      data: {
        targetType: 'post',
        reason: hit.reason,
        details: `Automatic screen: ${hit.label} (score ${hit.score.toFixed(2)}). Review before acting; the post was not hidden.`,
        reporter: { connect: { id: systemReporterUserId } },
        subjectPost: { connect: { id: post.id } },
      },
    });
    this.logger.log(`[content-screen] flagged post ${post.id} as ${hit.label}`);
    return 'flagged';
  }

  private async worthScreening(userId: string, createdAt: Date, body: string): Promise<boolean> {
    if (LINK.test(body)) return true;
    if (Date.now() - createdAt.getTime() < NEW_ACCOUNT_DAYS * 24 * 60 * 60 * 1000) return true;
    const count = await this.postsRead.read.count({ where: { userId, deletedAt: null }, take: NEW_AUTHOR_POST_COUNT + 1 });
    return count <= NEW_AUTHOR_POST_COUNT;
  }

  private async moderate(apiKey: string, input: string): Promise<Scores | null> {
    try {
      this.client ??= new OpenAI({ apiKey, timeout: 8_000, maxRetries: 1 });
      const result = await this.client.moderations.create({ model: 'omni-moderation-latest', input });
      return (result.results[0]?.category_scores as unknown as Scores | undefined) ?? null;
    } catch (err) {
      this.logger.warn(`[content-screen] failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}

/** Maps moderation scores to the report reasons admins already work with. */
export function classify(scores: Scores): { reason: ReportReason; label: string; score: number } | null {
  const pick = (keys: string[]) => keys.reduce((best, key) => Math.max(best, scores[key] ?? 0), 0);
  const candidates: Array<{ reason: ReportReason; label: string; score: number; min: number }> = [
    { reason: 'harassment', label: 'harassment or threats', score: pick(['harassment', 'harassment/threatening']), min: FLAG_SCORE },
    { reason: 'hate', label: 'hate', score: pick(['hate', 'hate/threatening']), min: FLAG_SCORE },
    { reason: 'sexual', label: 'sexual content', score: pick(['sexual', 'sexual/minors']), min: FLAG_SCORE },
    { reason: 'violence', label: 'violence', score: pick(['violence', 'violence/graphic']), min: FLAG_SCORE },
    { reason: 'illegal', label: 'illicit activity', score: pick(['illicit', 'illicit/violent']), min: FLAG_SCORE },
    { reason: 'other', label: 'possible self-harm, consider reaching out', score: pick(['self-harm', 'self-harm/intent', 'self-harm/instructions']), min: SELF_HARM_SCORE },
  ];
  const hits = candidates.filter((c) => c.score >= c.min).sort((a, b) => b.score - a.score);
  return hits[0] ?? null;
}
