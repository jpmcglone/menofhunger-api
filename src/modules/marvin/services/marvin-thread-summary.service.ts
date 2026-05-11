import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MarvinAIService } from './marvin-ai.service';

const SUMMARY_TRIGGER_REPLY_COUNT = 20;
const SUMMARY_INPUT_BODY_TRUNCATE = 320;
const SUMMARY_MAX_LENGTH = 1500;
const SUMMARY_INCLUDE_NEW_LIMIT = 50;

/**
 * Maintains a per-thread rolling summary used by Marv's `get_post_thread_summary`
 * tool. Summaries cap thread context at a fixed token cost regardless of how
 * many replies the conversation accumulates.
 *
 * Pattern:
 *  - After every successful Marv reply on a thread with ≥ `SUMMARY_TRIGGER_REPLY_COUNT`
 *    posts, enqueue a `marvin.summarizeThread` job for that `rootPostId`.
 *  - Job is idempotent: if no posts have arrived since `lastMessageIdIncluded`, it's a no-op.
 *  - Otherwise it builds a new summary by composing (existing summary + new posts) using
 *    the Fast model, and upserts the row with the latest `lastMessageIdIncluded`.
 *
 * The summary text is content-only — no editorial labels — so the model that consumes it
 * can still form its own opinion when answering.
 */
@Injectable()
export class MarvinThreadSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: MarvinAIService,
  ) {}

  /** Returns true if the thread currently meets the size threshold for summarization. */
  async shouldSummarize(rootPostId: string): Promise<boolean> {
    if (!rootPostId) return false;
    const replyCount = await this.prisma.post.count({
      where: { rootId: rootPostId, deletedAt: null, visibility: { not: 'onlyMe' } },
    });
    return replyCount >= SUMMARY_TRIGGER_REPLY_COUNT;
  }

  /**
   * Re-summarize the thread, picking up only the posts that have been added since
   * the previous summary. Returns the new summary text, or null if nothing changed
   * (or summarization isn't applicable).
   */
  async summarizeThread(rootPostId: string): Promise<string | null> {
    if (!rootPostId) return null;
    const existing = await this.prisma.marvinThreadSummary.findUnique({
      where: { rootPostId },
      select: { summary: true, lastMessageIdIncluded: true },
    });

    const newPosts = await this.fetchNewPostsSince(rootPostId, existing?.lastMessageIdIncluded ?? null);
    if (newPosts.length === 0 && existing) {
      // Nothing new since last run — no-op.
      return existing.summary;
    }

    const combined = await this.composeSummary({
      rootPostId,
      previousSummary: existing?.summary ?? null,
      newPosts,
    });
    if (!combined) return existing?.summary ?? null;

    const trimmed = combined.slice(0, SUMMARY_MAX_LENGTH).trim();
    const lastId = newPosts.length > 0 ? newPosts[newPosts.length - 1]!.id : existing?.lastMessageIdIncluded ?? null;
    await this.prisma.marvinThreadSummary.upsert({
      where: { rootPostId },
      update: { summary: trimmed, lastMessageIdIncluded: lastId, tokensApprox: estimateTokens(trimmed) },
      create: {
        rootPostId,
        summary: trimmed,
        lastMessageIdIncluded: lastId,
        tokensApprox: estimateTokens(trimmed),
      },
    });
    return trimmed;
  }

  private async fetchNewPostsSince(
    rootPostId: string,
    lastIncluded: string | null,
  ): Promise<Array<{ id: string; body: string; createdAt: Date; username: string | null }>> {
    let createdAtFloor: Date | null = null;
    if (lastIncluded) {
      const last = await this.prisma.post.findUnique({
        where: { id: lastIncluded },
        select: { createdAt: true },
      });
      createdAtFloor = last?.createdAt ?? null;
    }
    const rows = await this.prisma.post.findMany({
      where: {
        rootId: rootPostId,
        deletedAt: null,
        visibility: { not: 'onlyMe' },
        ...(createdAtFloor ? { createdAt: { gt: createdAtFloor } } : {}),
      },
      orderBy: [{ createdAt: 'asc' }],
      take: SUMMARY_INCLUDE_NEW_LIMIT,
      select: {
        id: true,
        body: true,
        createdAt: true,
        user: { select: { username: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      body: (r.body ?? '').trim(),
      createdAt: r.createdAt,
      username: r.user?.username ?? null,
    }));
  }

  private async composeSummary(input: {
    rootPostId: string;
    previousSummary: string | null;
    newPosts: Array<{ id: string; body: string; createdAt: Date; username: string | null }>;
  }): Promise<string | null> {
    if (!this.ai.isConfigured()) {
      // Without AI, fall back to a deterministic concatenation so the summary
      // is still useful (and still gets pruned by the max-length cap).
      const lines = input.newPosts.map(
        (p) => `- @${p.username ?? 'user'}: ${truncate(p.body, SUMMARY_INPUT_BODY_TRUNCATE)}`,
      );
      const base = input.previousSummary ? `${input.previousSummary}\n` : '';
      return `${base}${lines.join('\n')}`.trim() || null;
    }

    const developerNote = [
      'You maintain a rolling summary of a public thread for an AI helper.',
      'Output 80-180 words, plain prose, no headings, no bullet lists.',
      'Preserve key claims, decisions, questions, and tensions.',
      "Don't add opinions. Don't quote URLs. Use clear pronouns; refer to participants by @username when relevant.",
      'Integrate the new posts into the previous summary; do not just concatenate.',
    ].join(' ');

    const userMessage = buildSummaryUserMessage(input);

    const result = await this.ai.respond({
      source: 'public_thread',
      mode: 'fast',
      developerNote,
      userMessage,
      dispatchTool: async () => '{}',
      toolContext: { requesterUserId: '' },
      previousResponseId: null,
      cacheKey: 'marv:thread-summary',
    });
    const text = (result.text ?? '').trim();
    return text || null;
  }
}

function buildSummaryUserMessage(input: {
  rootPostId: string;
  previousSummary: string | null;
  newPosts: Array<{ body: string; username: string | null }>;
}): string {
  const lines: string[] = [];
  lines.push(`Thread root: ${input.rootPostId}`);
  if (input.previousSummary) {
    lines.push('');
    lines.push('Existing summary:');
    lines.push(input.previousSummary);
  }
  if (input.newPosts.length > 0) {
    lines.push('');
    lines.push('New posts (chronological):');
    for (const p of input.newPosts) {
      lines.push(`- @${p.username ?? 'user'}: ${truncate(p.body, SUMMARY_INPUT_BODY_TRUNCATE)}`);
    }
  }
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Rough token estimate (4 chars/token). Used as a hint, not a budget. */
function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}
