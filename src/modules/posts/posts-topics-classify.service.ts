import { Injectable, Logger } from '@nestjs/common';
import type { PostVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { AiUtilityService } from '../ai/ai-utility.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { TOPIC_OPTIONS } from '../../common/topics/topic-options';
import { parseModelTopicList } from '../../common/topics/topic-utils';

const ALLOWLIST_VALUES = TOPIC_OPTIONS.map((o) => o.value);
const CLASSIFY_INSTRUCTIONS = [
  'Assign topics to one public post on Men of Hunger.',
  'Return ONLY a JSON array of 0 to 5 topic values from this allowlist:',
  JSON.stringify(ALLOWLIST_VALUES),
  'Use a topic only when the post is clearly about it. Prefer fewer. Return [] if none fit.',
  'No prose, no keys, no markdown.',
].join(' ');

export type TopicsClassifyJobData = {
  postId?: string;
  batchSize?: number;
  runUntilEmpty?: boolean;
};

type ClassifyRow = {
  id: string;
  body: string | null;
  hashtags: string[];
  topics: string[];
  visibility: PostVisibility;
  communityGroupId: string | null;
  deletedAt: Date | null;
};

@Injectable()
export class PostsTopicsClassifyService {
  private readonly logger = new Logger(PostsTopicsClassifyService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiUtilityService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
    private readonly cacheInvalidation: CacheInvalidationService,
  ) {}

  async enqueueIfNeeded(postId: string): Promise<void> {
    const id = (postId ?? '').trim();
    if (!id || !this.ai.isConfigured()) return;
    const post = await this.prisma.post.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        body: true,
        hashtags: true,
        topics: true,
        visibility: true,
        communityGroupId: true,
        deletedAt: true,
      },
    });
    if (!post || !this.isEligible(post)) return;
    try {
      await this.jobs.enqueue(
        JOBS.postsTopicsAiClassify,
        { postId: id },
        { jobId: `topics-ai-${id}`, attempts: 2, backoff: { type: 'exponential', delay: 30_000 } },
      );
    } catch {
      // Duplicate jobId while a classify is already queued — fine.
    }
  }

  async process(data?: TopicsClassifyJobData): Promise<{ classified: number; examined: number }> {
    const postId = (data?.postId ?? '').trim();
    if (postId) {
      const wrote = await this.classifyOne(postId);
      return { classified: wrote ? 1 : 0, examined: 1 };
    }
    if (this.running) return { classified: 0, examined: 0 };
    this.running = true;
    try {
      return await this.classifyBatch({
        batchSize: data?.batchSize,
        runUntilEmpty: Boolean(data?.runUntilEmpty),
      });
    } finally {
      this.running = false;
    }
  }

  private async classifyBatch(opts: {
    batchSize?: number;
    runUntilEmpty?: boolean;
  }): Promise<{ classified: number; examined: number }> {
    if (!this.ai.isConfigured()) return { classified: 0, examined: 0 };
    const batchSize = Math.max(1, Math.min(40, Math.floor(opts.batchSize ?? 20)));
    const maxBatches = opts.runUntilEmpty ? 40 : 1;
    let classified = 0;
    let examined = 0;

    for (let batch = 0; batch < maxBatches; batch++) {
      const rows = await this.prisma.post.findMany({
        where: this.eligibleWhere(),
        select: {
          id: true,
          body: true,
          hashtags: true,
          topics: true,
          visibility: true,
          communityGroupId: true,
          deletedAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: batchSize,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        examined += 1;
        if (await this.classifyRow(row)) classified += 1;
      }
      if (!opts.runUntilEmpty) break;
      if (rows.length < batchSize) break;
    }

    if (examined > 0) {
      this.logger.log(`[topics-ai] classified ${classified}/${examined} posts`);
    }
    return { classified, examined };
  }

  private async classifyOne(postId: string): Promise<boolean> {
    const post = await this.prisma.post.findFirst({
      where: { id: postId },
      select: {
        id: true,
        body: true,
        hashtags: true,
        topics: true,
        visibility: true,
        communityGroupId: true,
        deletedAt: true,
      },
    });
    if (!post) return false;
    return this.classifyRow(post);
  }

  private async classifyRow(post: ClassifyRow): Promise<boolean> {
    if (!this.isEligible(post)) return false;
    const model = this.appConfig.marvOpenAI().fastModel;
    const userMessage = [
      `Body:\n${(post.body ?? '').trim() || '—'}`,
      post.hashtags.length ? `Hashtags: ${post.hashtags.map((t) => `#${t}`).join(' ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const result = await this.ai.complete({
      model,
      instructions: CLASSIFY_INSTRUCTIONS,
      userMessage,
      maxOutputTokens: 256,
      reasoningEffort: 'low',
      cacheKey: 'topics:classify',
    });
    const topics = parseModelTopicList(result?.text ?? '');
    if (topics.length === 0) return false;

    await this.prisma.post.update({
      where: { id: post.id },
      data: { topics },
    });
    await this.cacheInvalidation.bumpForPostWrite({ topics });
    return true;
  }

  isEligible(post: {
    deletedAt?: Date | null;
    visibility: PostVisibility | string;
    communityGroupId: string | null;
    topics: string[] | null;
    body: string | null;
    hashtags: string[] | null;
  }): boolean {
    if (post.deletedAt) return false;
    if (post.visibility === 'onlyMe') return false;
    if (post.communityGroupId) return false;
    if (Array.isArray(post.topics) && post.topics.length > 0) return false;
    const body = (post.body ?? '').trim();
    const tags = Array.isArray(post.hashtags) ? post.hashtags : [];
    return Boolean(body || tags.length);
  }

  private eligibleWhere() {
    return {
      deletedAt: null,
      visibility: { not: 'onlyMe' as const },
      communityGroupId: null,
      topics: { equals: [] },
    };
  }
}
