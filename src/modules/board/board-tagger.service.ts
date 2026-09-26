import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { AiUtilityService } from '../ai/ai-utility.service';
import { LinkMetadataService } from '../link-metadata/link-metadata.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { BOARD_MAX_TAGS, normalizeBoardTags } from './board.utils';

/** Links read per post: the post's own link plus the first few in its text. */
const MAX_LINKS = 4;
/** Established tags offered to the model so the Board converges on a shared vocabulary. */
const VOCABULARY_SIZE = 60;

const INSTRUCTIONS = `You tag posts on the Men of Hunger Board, a Hacker News-style link and discussion board for men.
Choose 1 to ${BOARD_MAX_TAGS} tags that a reader would filter by to find this post.
Rules:
- Tags are lowercase slugs: letters, digits, and single hyphens (e.g. "fitness", "personal-finance").
- Strongly prefer tags from the existing vocabulary when one fits. Invent a new tag only when none does.
- "ask" is for posts that ask the community a question. "show" is for a member sharing something they made. "hiring" is for job posts.
- Describe the subject, not the tone. No tags for the site name alone, no "misc", no "general".
Reply with only a JSON array of strings, e.g. ["ask","fitness"].`;

/** Pull the first JSON array of strings out of a model reply. */
export function parseTagList(text: string): string[] {
  const match = (text ?? '').match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Sets a Board post's tags from what it's about: title, text, its link, and the other links in
 * its text (each link's title and description, fetched and cached by LinkMetadataService).
 * Members don't pick tags; this runs once after a post is created or its content changes.
 */
@Injectable()
export class BoardTaggerService {
  private readonly logger = new Logger(BoardTaggerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly ai: AiUtilityService,
    private readonly linkMetadata: LinkMetadataService,
    private readonly realtime: PresenceRealtimeService,
  ) {}

  async tagThread(threadId: string): Promise<string[] | null> {
    const row = await this.prisma.post.findFirst({
      where: { id: threadId, kind: 'board', parentId: null, deletedAt: null },
      select: {
        id: true,
        body: true,
        boardThread: { select: { title: true, url: true, tags: true } },
        article: { select: { title: true, excerpt: true } },
      },
    });
    if (!row?.boardThread) return null;

    const links = [row.boardThread.url, ...this.linkMetadata.extractLinks(row.body ?? '')]
      .filter((u): u is string => Boolean(u))
      .filter((u, i, all) => all.indexOf(u) === i)
      .slice(0, MAX_LINKS);
    const [metas, vocabulary] = await Promise.all([
      Promise.all(links.map((url) => this.linkMetadata.getMetadata(url).catch(() => null))),
      this.prisma.boardTag.findMany({
        where: { threadCount: { gt: 0 } },
        orderBy: [{ threadCount: 'desc' }, { slug: 'asc' }],
        take: VOCABULARY_SIZE,
        select: { slug: true },
      }),
    ]);

    const linkLines = links.map((url, i) => {
      const meta = metas[i];
      const detail = [meta?.siteName, meta?.title, meta?.description].filter(Boolean).join(' — ');
      return `- ${url}${detail ? `\n  ${detail.slice(0, 400)}` : ''}`;
    });
    const userMessage = [
      `Title: ${row.boardThread.title}`,
      row.article ? `Article: ${row.article.title}${row.article.excerpt ? ` — ${row.article.excerpt}` : ''}` : '',
      row.body?.trim() ? `Text:\n${row.body.trim().slice(0, 2000)}` : '',
      linkLines.length ? `Links:\n${linkLines.join('\n')}` : '',
      `Existing vocabulary: ${vocabulary.map((t) => t.slug).join(', ') || '(none yet)'}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const result = await this.ai.complete({
      model: this.appConfig.marvOpenAI().fastModel,
      instructions: INSTRUCTIONS,
      userMessage,
      maxOutputTokens: 128,
      reasoningEffort: 'low',
      cacheKey: 'board:tags',
    });
    const tags = normalizeBoardTags(parseTagList(result?.text ?? '')).slice(0, BOARD_MAX_TAGS);
    if (tags.length === 0) return null;

    const previous = row.boardThread.tags;
    await this.prisma.boardThread.update({ where: { postId: row.id }, data: { tags } });
    await this.adjustTagCounts(previous, tags);
    this.realtime.emitPostsLiveUpdated(row.id, {
      postId: row.id,
      version: new Date().toISOString(),
      reason: 'post_edited',
      patch: {},
    });
    this.logger.debug(`[board] tagged ${row.id}: ${tags.join(', ')}`);
    return tags;
  }

  private async adjustTagCounts(previous: string[], next: string[]): Promise<void> {
    const now = new Date();
    const added = next.filter((t) => !previous.includes(t));
    const removed = previous.filter((t) => !next.includes(t));
    await Promise.all([
      ...added.map((slug) =>
        this.prisma.boardTag.upsert({
          where: { slug },
          create: { slug, label: slug, threadCount: 1, lastUsedAt: now },
          update: { threadCount: { increment: 1 }, lastUsedAt: now },
        }),
      ),
      ...removed.map((slug) =>
        this.prisma.boardTag.updateMany({ where: { slug, threadCount: { gt: 0 } }, data: { threadCount: { decrement: 1 } } }),
      ),
    ]);
  }
}
