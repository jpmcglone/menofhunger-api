import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { marvChannelSourceWhere } from '../../group-channels/channel-marv-scope.service';
import { PostsPublicRecordService } from '../../posts/posts-public-record.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MARV_PUBLIC_KNOWLEDGE } from '../marvin-prompt-instructions';

/** Where this reply is being delivered. The model never supplies these ids. */
export type MarvPlatformScope = {
  groupId?: string | null;
  /** Set when the reply is inside a channel. Omitted from the briefing because that channel's history is already in the note. */
  channelId?: string | null;
  /** True only when this reply is inside that private channel. */
  privateChannel?: boolean;
};

type PublicPostRow = { author: string | null; createdAt: Date; body: string };
type ArticleRow = { author: string | null; publishedAt: Date; title: string; excerpt: string | null };
type BoardRow = { author: string | null; createdAt: Date; title: string; body: string };
type ChannelLine = { channel: string; author: string | null; createdAt: Date; body: string };

const PUBLIC_POSTS = 6;
const ARTICLES = 4;
const BOARD = 5;
const GROUP_POSTS = 6;
const CHANNEL_MESSAGES = 8;
const BODY = 180;

function clip(value: string | null | undefined): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, BODY) : '(no text)';
}

function who(username: string | null | undefined): string {
  const handle = (username ?? '').trim();
  return handle ? `@${handle}` : 'someone';
}

function day(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function section(title: string, lines: string[]): string[] {
  return [title, ...(lines.length > 0 ? lines : ['- none right now'])];
}

/**
 * Compact live record of public Men of Hunger, plus the current group when
 * the reply is inside one. Private-channel text is not included here; the
 * channel reply already carries that channel's own history.
 */
export function renderMarvPlatformBriefing(input: {
  posts: PublicPostRow[];
  articles: ArticleRow[];
  board: BoardRow[];
  group: { name: string; posts: PublicPostRow[]; messages: ChannelLine[] } | null;
}): string {
  const lines = [
    MARV_PUBLIC_KNOWLEDGE,
    '',
    ...section(
      'Public posts:',
      input.posts.map((post) => `- ${who(post.author)} (${day(post.createdAt)}): ${clip(post.body)}`),
    ),
    ...section(
      'Published articles:',
      input.articles.map(
        (article) => `- ${who(article.author)} (${day(article.publishedAt)}): ${clip(article.title)}${article.excerpt ? ` — ${clip(article.excerpt)}` : ''}`,
      ),
    ),
    ...section(
      'Board:',
      input.board.map((thread) => `- ${who(thread.author)} (${day(thread.createdAt)}): ${clip(thread.title)}${thread.body ? ` — ${clip(thread.body)}` : ''}`),
    ),
  ];
  if (input.group) {
    lines.push(
      '',
      `This group "${input.group.name}":`,
      ...section(
        'Feed posts:',
        input.group.posts.map((post) => `- ${who(post.author)} (${day(post.createdAt)}): ${clip(post.body)}`),
      ),
      ...section(
        'Other channels you can see from here:',
        input.group.messages.map(
          (message) => `- #${message.channel} ${who(message.author)} (${day(message.createdAt)}): ${clip(message.body)}`,
        ),
      ),
    );
  }
  return lines.join('\n');
}

@Injectable()
export class MarvinPlatformContextService {
  private readonly logger = new Logger(MarvinPlatformContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly postsRecord: PostsPublicRecordService,
  ) {}

  /** Always returns a note Marv can answer from. A database miss does not become "I don't know." */
  async briefing(scope: MarvPlatformScope = {}): Promise<string> {
    try {
      const loaded = await this.load(scope);
      return renderMarvPlatformBriefing(loaded);
    } catch (error) {
      this.logger.warn(
        `[marv] platform briefing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return `${MARV_PUBLIC_KNOWLEDGE}\nThe live briefing failed to load. Call list_public_posts, list_public_articles, and list_board before you answer about Men of Hunger.`;
    }
  }

  async listPublicArticles(limit = ARTICLES): Promise<{ articles: ArticleRow[] }> {
    const rows = await this.prisma.article.findMany({
      where: {
        deletedAt: null,
        isDraft: false,
        publishedAt: { not: null },
        visibility: 'public',
        author: { bannedAt: null },
      },
      orderBy: { publishedAt: 'desc' },
      take: clamp(limit),
      select: { title: true, excerpt: true, publishedAt: true, author: { select: { username: true } } },
    });
    return {
      articles: rows.flatMap((row) =>
        row.publishedAt
          ? [{ author: row.author.username, publishedAt: row.publishedAt, title: row.title, excerpt: row.excerpt }]
          : [],
      ),
    };
  }

  async listBoard(limit = BOARD): Promise<{ threads: BoardRow[] }> {
    const rows = await this.postsRecord.recentBoardThreads(clamp(limit));
    return {
      threads: rows.map((row) => ({
        author: row.author,
        createdAt: row.createdAt,
        title: row.title || clip(row.body),
        body: row.title ? row.body : '',
      })),
    };
  }

  async listGroupFeed(groupId: string, limit = GROUP_POSTS): Promise<{ posts: PublicPostRow[] }> {
    return { posts: await this.postsRecord.recentGroupPosts(groupId, clamp(limit)) };
  }

  /**
   * Channel text the reply is allowed to discuss. Normal channels in the group,
   * plus the current private channel only when the reply is inside it.
   */
  async searchChannels(scope: MarvPlatformScope, query: string): Promise<{ messages: ChannelLine[] } | { error: string; messages: [] }> {
    const groupId = (scope.groupId ?? '').trim();
    const q = query.trim().slice(0, 200);
    if (!groupId) return { error: 'not_in_a_group', messages: [] };
    if (!q) return { error: 'invalid_query', messages: [] };
    const rows = await this.prisma.message.findMany({
      where: {
        deletedForAll: false,
        kind: 'text',
        body: { contains: q, mode: 'insensitive' },
        sender: { bannedAt: null },
        conversation: { groupChannel: this.channelWhere(groupId, scope, false) },
      },
      orderBy: { createdAt: 'desc' },
      take: CHANNEL_MESSAGES,
      select: channelSelect(),
    });
    return { messages: rows.map(toChannelLine) };
  }

  private async load(scope: MarvPlatformScope): Promise<{
    posts: PublicPostRow[];
    articles: ArticleRow[];
    board: BoardRow[];
    group: { name: string; posts: PublicPostRow[]; messages: ChannelLine[] } | null;
  }> {
    const groupId = (scope.groupId ?? '').trim() || null;
    const [posts, articles, board, group] = await Promise.all([
      this.recentPublicPosts(),
      this.listPublicArticles(ARTICLES),
      this.listBoard(BOARD),
      groupId ? this.groupSection(groupId, scope) : Promise.resolve(null),
    ]);
    return { posts, articles: articles.articles, board: board.threads, group };
  }

  private async recentPublicPosts(): Promise<PublicPostRow[]> {
    return this.postsRecord.recentPublicPosts(PUBLIC_POSTS);
  }

  private async groupSection(groupId: string, scope: MarvPlatformScope) {
    const group = await this.prisma.communityGroup.findFirst({
      where: { id: groupId, deletedAt: null },
      select: { name: true },
    });
    if (!group) return null;
    const [posts, messages] = await Promise.all([
      this.listGroupFeed(groupId, GROUP_POSTS),
      this.recentChannelMessages(groupId, scope),
    ]);
    return { name: group.name, posts: posts.posts, messages };
  }

  private async recentChannelMessages(groupId: string, scope: MarvPlatformScope): Promise<ChannelLine[]> {
    const rows = await this.prisma.message.findMany({
      where: {
        deletedForAll: false,
        kind: 'text',
        sender: { bannedAt: null },
        conversation: { groupChannel: this.channelWhere(groupId, scope, true) },
      },
      orderBy: { createdAt: 'desc' },
      take: CHANNEL_MESSAGES,
      select: channelSelect(),
    });
    return rows.reverse().map(toChannelLine);
  }

  /** `omitCurrent` keeps the channel being answered out of the briefing; its history is already in the note. */
  private channelWhere(groupId: string, scope: MarvPlatformScope, omitCurrent: boolean): Prisma.GroupChannelWhereInput {
    const channelId = (scope.channelId ?? '').trim();
    const includeThisPrivate = Boolean(scope.privateChannel && channelId);
    return {
      ...marvChannelSourceWhere(groupId, channelId || 'none', includeThisPrivate),
      archivedAt: null,
      ...(omitCurrent && channelId ? { NOT: { id: channelId } } : {}),
    };
  }
}

function channelSelect() {
  return {
    body: true,
    createdAt: true,
    sender: { select: { username: true } },
    conversation: { select: { groupChannel: { select: { name: true } } } },
  };
}

function toChannelLine(row: {
  body: string;
  createdAt: Date;
  sender: { username: string | null };
  conversation: { groupChannel: { name: string } | null };
}): ChannelLine {
  return {
    channel: row.conversation.groupChannel?.name ?? 'channel',
    author: row.sender.username,
    createdAt: row.createdAt,
    body: row.body,
  };
}

function clamp(limit: number): number {
  if (!Number.isFinite(limit)) return 5;
  return Math.min(8, Math.max(1, Math.trunc(limit)));
}
