import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { chunk, FANOUT_CONCURRENCY, runInBatches } from '../side-effects/batch';
import {
  FANOUT_CHUNK_SIZE,
  FANOUT_CHUNK_THRESHOLD,
  type SideEffectPayloads,
} from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { SideEffectsService } from '../side-effects/side-effects.service';

/**
 * Notification work that follows an article mutation, run off the request path.
 *
 * Publishing an article used to loop every follower on the API process firing un-awaited
 * `notifications.create()` calls — 500 followers meant ~2000 unbounded-parallel queries
 * competing with live requests for the same Prisma pool. Here the same fan-out is bounded and
 * retryable, and it runs where it can't hurt anyone's request latency.
 *
 * Content emits (`articles:commentAdded`, `articles:liveUpdated`, reaction summaries) stay in
 * `ArticlesService` — viewers expect those instantly and they don't need durability.
 */
@Injectable()
export class ArticlesSideEffectsHandler implements OnModuleInit {
  private readonly logger = new Logger(ArticlesSideEffectsHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly registry: SideEffectsRegistry,
    private readonly sideEffects: SideEffectsService,
  ) {}

  onModuleInit(): void {
    this.registry.register('article.published', (payload) => this.onArticlePublished(payload));
    this.registry.register('article.comment.created', (payload) => this.onCommentCreated(payload));
    this.registry.register('article.boosted', (payload) => this.onBoosted(payload));
    this.registry.register('article.reaction.added', (payload) => this.onReactionAdded(payload));
  }

  /** `followed_article` fan-out on first publish, filtered by the article's visibility tier. */
  private async onArticlePublished(payload: SideEffectPayloads['article.published']): Promise<void> {
    const { articleId, authorUserId } = payload;
    if (!articleId || !authorUserId) return;

    const article = await this.prisma.article.findFirst({
      where: { id: articleId, deletedAt: null },
      select: { title: true, visibility: true, publishedAt: true },
    });
    // Unpublished or deleted since the dispatch — nothing to announce.
    if (!article?.publishedAt) return;

    const [follows, operators] = await Promise.all([
      this.prisma.follow.findMany({
        where: { followingId: authorUserId },
        select: {
          followerId: true,
          follower: { select: { verifiedStatus: true, premium: true, premiumPlus: true } },
        },
      }),
      this.prisma.userPageOperator.findMany({
        where: { pageUserId: authorUserId },
        select: { operatorUserId: true },
      }),
    ]);
    const operatorIds = new Set(operators.map((row) => row.operatorUserId));

    const title = article.title ?? '';
    const titleSnippet = title.length > 80 ? `${title.slice(0, 79)}…` : title;

    const recipientUserIds: string[] = [];
    for (const f of follows) {
      const recipientUserId = f.followerId;
      if (!recipientUserId || recipientUserId === authorUserId) continue;
      if (operatorIds.has(recipientUserId)) continue;

      if (article.visibility === 'verifiedOnly') {
        const vs = f.follower?.verifiedStatus ?? 'none';
        if (!vs || vs === 'none') continue;
      }
      if (article.visibility === 'premiumOnly') {
        if (!f.follower?.premium && !f.follower?.premiumPlus) continue;
      }
      recipientUserIds.push(recipientUserId);
    }

    if (recipientUserIds.length > FANOUT_CHUNK_THRESHOLD) {
      for (const slice of chunk(recipientUserIds, FANOUT_CHUNK_SIZE)) {
        this.sideEffects.dispatch('notification.fanout.chunk', {
          kind: 'followed_article',
          recipientUserIds: slice,
          actorUserId: authorUserId,
          actorPostId: null,
          subjectPostId: null,
          subjectUserId: authorUserId,
          subjectArticleId: articleId,
          subjectGroupId: null,
          title: null,
          body: titleSnippet || null,
        });
      }
      return;
    }

    await runInBatches(recipientUserIds, FANOUT_CONCURRENCY, async (recipientUserId) => {
      await this.notifications
        .create({
          recipientUserId,
          kind: 'followed_article',
          actorUserId: authorUserId,
          subjectArticleId: articleId,
          subjectUserId: authorUserId,
          body: titleSnippet || undefined,
        })
        .catch((err) => {
          this.logger.warn(
            `[notifications] Failed to create followed-article notification: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    });
  }

  /**
   * Reply + mention notifications for a new article comment.
   *
   * Mention usernames are carried in the payload because they were already parsed on the
   * request path; the resolution to user ids happens here.
   */
  private async onCommentCreated(payload: SideEffectPayloads['article.comment.created']): Promise<void> {
    const { articleId, commentId, actorUserId, parentCommentId, mentionUsernames } = payload;
    if (!articleId || !commentId || !actorUserId) return;

    const comment = await this.prisma.articleComment.findFirst({
      where: { id: commentId, deletedAt: null },
      select: { body: true },
    });
    if (!comment) return;

    const bodySnippet = comment.body?.slice(0, 150) ?? null;

    const mentionUsers = mentionUsernames.length
      ? await this.prisma.user.findMany({
          where: { username: { in: mentionUsernames } },
          select: { id: true },
        })
      : [];
    const mentionUserIds = new Set<string>(mentionUsers.map((u) => u.id));

    const art = await this.prisma.article.findUnique({ where: { id: articleId }, select: { authorId: true } });
    if (!art) return;

    const recipientId = parentCommentId
      ? ((await this.prisma.articleComment.findUnique({ where: { id: parentCommentId }, select: { authorId: true } }))
          ?.authorId ?? art.authorId)
      : art.authorId;

    // Keep parity with post reply behavior: explicit @mentions take priority over reply notifications.
    if (recipientId !== actorUserId && !mentionUserIds.has(recipientId)) {
      await this.notifications
        .create({
          recipientUserId: recipientId,
          kind: 'comment',
          actorUserId,
          subjectArticleId: articleId,
          subjectArticleCommentId: commentId,
          title: parentCommentId ? 'replied to your reply' : 'replied to your article',
          body: bodySnippet,
        })
        .catch((err) => {
          this.logger.warn(
            `[notifications] Failed to create article comment notification: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    const mentionRecipients = [...mentionUserIds].filter((id) => id !== actorUserId);
    await runInBatches(mentionRecipients, FANOUT_CONCURRENCY, async (mentionedUserId) => {
      await this.notifications
        .create({
          recipientUserId: mentionedUserId,
          kind: 'mention',
          actorUserId,
          subjectArticleId: articleId,
          subjectArticleCommentId: commentId,
          title: 'mentioned you in an article reply',
          body: bodySnippet,
        })
        .catch((err) => {
          this.logger.warn(
            `[notifications] Failed to create article mention notification: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    });
  }

  private async onBoosted(payload: SideEffectPayloads['article.boosted']): Promise<void> {
    const { articleId, actorUserId } = payload;
    if (!articleId || !actorUserId) return;

    const article = await this.prisma.article.findUnique({
      where: { id: articleId },
      select: { authorId: true, title: true },
    });
    if (!article || article.authorId === actorUserId) return;

    await this.notifications.create({
      recipientUserId: article.authorId,
      kind: 'boost',
      actorUserId,
      subjectArticleId: articleId,
      title: 'boosted your article',
      body: article.title?.trim() ? article.title.trim().slice(0, 150) : null,
    });
  }

  private async onReactionAdded(payload: SideEffectPayloads['article.reaction.added']): Promise<void> {
    const { articleId, actorUserId, emoji } = payload;
    if (!articleId || !actorUserId) return;

    const article = await this.prisma.article.findUnique({
      where: { id: articleId },
      select: { authorId: true },
    });
    if (!article || article.authorId === actorUserId) return;

    await this.notifications.create({
      recipientUserId: article.authorId,
      kind: 'generic',
      actorUserId,
      subjectArticleId: articleId,
      title: 'reacted to your article',
      body: emoji,
    });
  }
}
