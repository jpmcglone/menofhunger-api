import { estimateReadingTimeMinutes } from '../../common/dto/article.dto';
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PostVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PostsService } from '../posts/posts.service';
import { ViewerContextService, type ViewerContext } from '../viewer/viewer-context.service';
import { AppConfigService } from '../app/app-config.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { POST_BASE_INCLUDE, POST_LIST_INCLUDE } from '../../common/prisma-includes/post.include';
import { createdAtIdCursorWhere } from '../../common/pagination/created-at-id-cursor';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import {
  toBoardCommentDto,
  toBoardThreadDto,
  toPostDto,
  toUserListDto,
  type BoardCommentContextDto,
  type BoardCommentDto,
  type BoardCommentsPageDto,
  type BoardLeaderboardDto,
  type BoardLeaderboardUserDto,
  type BoardPreferencesDto,
  type BoardTagDto,
  type BoardThreadDto,
  type BoardVisibility,
  type PostWithAuthorAndMedia,
} from '../../common/dto';
import {
  BOARD_COMMENTS_MAX_ROWS,
  BOARD_DUPLICATE_WINDOW_DAYS,
  BOARD_MAX_TAGS,
  BOARD_SEED_TAGS,
  BOARD_THREADS_PER_HOUR,
  BOARD_TITLE_MAX,
  BOARD_TITLE_MIN,
  BOARD_TOP_CANDIDATES,
  BOARD_TOP_LOOKBACK_DAYS,
  boardHotScore,
  boardRangeStart,
  decodeOffsetCursor,
  encodeOffsetCursor,
  normalizeBoardTags,
  normalizeBoardUrl,
  slugifyBoardTag,
  type BoardRange,
} from './board.utils';

type ThreadRow = Prisma.PostGetPayload<{ include: typeof POST_LIST_INCLUDE }>;
type CommentRow = Prisma.PostGetPayload<{ include: typeof POST_BASE_INCLUDE }>;

const EDIT_WINDOW_MS = 30 * 60 * 1000;
const MAX_EDITS = 3;
const BOARD_VISIBILITIES: BoardVisibility[] = ['public', 'verifiedOnly', 'premiumOnly'];

export type BoardListParams = {
  viewerUserId: string | null;
  sort: 'top' | 'new';
  range: BoardRange | null;
  visibility: 'all' | BoardVisibility;
  tags: string[];
  domain: string | null;
  q: string | null;
  authorUsername: string | null;
  /** Only threads the viewer hid, so they can be brought back. */
  hiddenOnly?: boolean;
  limit: number;
  cursor: string | null;
};

export type BoardCreateThreadInput = {
  title: string;
  url: string | null;
  body: string | null;
  image: { r2Key: string; width: number | null; height: number | null; alt: string | null } | null;
  tags: string[];
  visibility: BoardVisibility;
  showInFeed: boolean;
};

@Injectable()
export class BoardService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
    private readonly viewerContext: ViewerContextService,
    private readonly appConfig: AppConfigService,
    private readonly realtime: PresenceRealtimeService,
    private readonly sideEffects: SideEffectsService,
  ) {}

  /** One-shot: repair mirrored article comment counts; drop bodies that were auto-copied from the article excerpt. */
  async onModuleInit() {
    const threads = await this.prisma.post.findMany({
      where: { kind: 'board', articleId: { not: null }, parentId: null, deletedAt: null },
      select: { id: true, body: true, articleId: true },
    });
    if (!threads.length) return;
    await this.repairArticleBoardCommentCounts(threads.map((t) => t.id));

    const articleIds = [...new Set(threads.map((t) => t.articleId!).filter(Boolean))];
    const articles = await this.prisma.article.findMany({
      where: { id: { in: articleIds } },
      select: { id: true, excerpt: true },
    });
    const excerptById = new Map(articles.map((a) => [a.id, (a.excerpt ?? '').trim().slice(0, 280)]));
    const mirrored = threads.filter((t) => {
      const excerpt = excerptById.get(t.articleId!);
      const body = (t.body ?? '').trim();
      return Boolean(excerpt && body && body === excerpt);
    });
    if (mirrored.length) {
      await this.prisma.post.updateMany({ where: { id: { in: mirrored.map((t) => t.id) } }, data: { body: '' } });
    }
  }

  private get publicBaseUrl(): string | null {
    return this.appConfig.r2()?.publicBaseUrl ?? null;
  }

  private canRead(viewer: ViewerContext | null, row: { userId: string; visibility: PostVisibility }): boolean {
    if (row.visibility === 'public') return true;
    if (!viewer) return false;
    if (viewer.siteAdmin || viewer.id === row.userId) return true;
    return this.viewerContext.allowedPostVisibilities(viewer).includes(row.visibility);
  }

  private readableVisibilities(viewer: ViewerContext | null): PostVisibility[] {
    if (viewer?.siteAdmin) return BOARD_VISIBILITIES;
    return this.viewerContext.allowedPostVisibilities(viewer).filter((v) => v !== 'onlyMe');
  }

  private canEdit(viewer: ViewerContext | null, row: { userId: string; createdAt: Date; editCount: number }): boolean {
    if (!viewer) return false;
    if (viewer.siteAdmin) return true;
    if (viewer.id !== row.userId) return false;
    return Date.now() <= row.createdAt.getTime() + EDIT_WINDOW_MS && row.editCount < MAX_EDITS;
  }

  // ─── Threads ────────────────────────────────────────────────────────────────

  async listThreads(params: BoardListParams): Promise<{ threads: BoardThreadDto[]; nextCursor: string | null }> {
    const viewer = await this.viewerContext.getViewer(params.viewerUserId);
    const limit = Math.max(1, Math.min(50, params.limit));
    const q = (params.q ?? '').trim().slice(0, 120);
    const tags = normalizeBoardTags(params.tags).slice(0, BOARD_MAX_TAGS);
    const authorUsername = (params.authorUsername ?? '').trim();

    const and: Prisma.PostWhereInput[] = [
      { kind: 'board', parentId: null, deletedAt: null, isDraft: false },
      authorUsername
        ? { user: { bannedAt: null, username: { equals: authorUsername, mode: 'insensitive' } } }
        : { user: { bannedAt: null } },
      { visibility: params.visibility === 'all' ? { in: BOARD_VISIBILITIES } : params.visibility },
    ];
    const threadWhere: Prisma.BoardThreadWhereInput = {
      ...(tags.length ? { tags: { hasSome: tags } } : {}),
      ...(params.domain ? { domain: params.domain.trim().toLowerCase().replace(/^www\./, '') } : {}),
    };
    if (Object.keys(threadWhere).length) and.push({ boardThread: { is: threadWhere } });
    // The Board is site-wide: only visibility tier and the viewer's own hides shape the list, never follows.
    if (params.hiddenOnly) {
      if (!viewer) return { threads: [], nextCursor: null };
      and.push({ boardHides: { some: { userId: viewer.id } } });
    } else if (viewer && !authorUsername) {
      and.push({ boardHides: { none: { userId: viewer.id } } });
    }
    if (q) {
      and.push({
        OR: [
          { boardThread: { is: { title: { contains: q, mode: 'insensitive' } } } },
          // Text matches only for threads the viewer can read, so search can't probe gated bodies.
          { body: { contains: q, mode: 'insensitive' }, visibility: { in: this.readableVisibilities(viewer) } },
        ],
      });
    }
    const where: Prisma.PostWhereInput = { AND: and };

    let rows: ThreadRow[];
    let nextCursor: string | null = null;

    if (params.sort === 'new') {
      const cursorWhere = await createdAtIdCursorWhere({
        cursor: params.cursor,
        lookup: (id) => this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
      });
      rows = await this.prisma.post.findMany({
        where: cursorWhere ? { AND: [where, cursorWhere] } : where,
        include: POST_LIST_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      if (rows.length > limit) {
        rows = rows.slice(0, limit);
        nextCursor = rows[rows.length - 1]?.id ?? null;
      }
    } else if (params.range) {
      const offset = decodeOffsetCursor(params.cursor);
      const start = boardRangeStart(params.range);
      rows = await this.prisma.post.findMany({
        where: start ? { AND: [where, { createdAt: { gte: start } }] } : where,
        include: POST_LIST_INCLUDE,
        orderBy: [{ boostCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit + 1,
      });
      if (rows.length > limit) {
        rows = rows.slice(0, limit);
        nextCursor = encodeOffsetCursor(offset + limit);
      }
    } else {
      const offset = decodeOffsetCursor(params.cursor);
      const now = new Date();
      const since = new Date(now.getTime() - BOARD_TOP_LOOKBACK_DAYS * 86_400_000);
      const candidates = await this.prisma.post.findMany({
        where: { AND: [where, { createdAt: { gte: since } }] },
        select: { id: true, boostCount: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: BOARD_TOP_CANDIDATES,
      });
      const ranked = candidates
        .map((c) => ({ id: c.id, score: boardHotScore(c.boostCount, c.createdAt, now), createdAt: c.createdAt }))
        .sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime());
      const pageIds = ranked.slice(offset, offset + limit).map((r) => r.id);
      if (ranked.length > offset + limit) nextCursor = encodeOffsetCursor(offset + limit);
      const byId = new Map(
        (await this.prisma.post.findMany({ where: { id: { in: pageIds } }, include: POST_LIST_INCLUDE })).map((r) => [r.id, r]),
      );
      rows = pageIds.map((id) => byId.get(id)).filter((r): r is ThreadRow => Boolean(r));
    }

    return { threads: await this.hydrateThreads(viewer, rows), nextCursor };
  }

  async getThread(viewerUserId: string | null, threadId: string): Promise<BoardThreadDto> {
    const viewer = await this.viewerContext.getViewer(viewerUserId);
    const row = await this.findThreadRow(threadId);
    const [dto] = await this.hydrateThreads(viewer, [row]);
    return dto!;
  }

  private async findThreadRow(threadId: string): Promise<ThreadRow> {
    const id = (threadId ?? '').trim();
    const row = id
      ? await this.prisma.post.findFirst({
          where: { id, kind: 'board', parentId: null, deletedAt: null, isDraft: false },
          include: POST_LIST_INCLUDE,
        })
      : null;
    if (!row || !row.boardThread) throw new NotFoundException('Post not found.');
    return row;
  }

  private async hydrateThreads(viewer: ViewerContext | null, rows: ThreadRow[]): Promise<BoardThreadDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [boosted, bookmarks, lastSeen, hidden] = await Promise.all([
      viewer ? this.posts.viewerBoostedPostIds({ viewerUserId: viewer.id, postIds: ids }) : Promise.resolve(new Set<string>()),
      viewer
        ? this.posts.viewerBookmarksByPostId({ viewerUserId: viewer.id, postIds: ids })
        : Promise.resolve(new Map<string, { collectionIds: string[] }>()),
      viewer
        ? this.posts.viewerLastSeenAtByPostId({ viewerUserId: viewer.id, postIds: ids })
        : Promise.resolve(new Map<string, Date>()),
      viewer
        ? this.prisma.boardHide.findMany({ where: { userId: viewer.id, postId: { in: ids } }, select: { postId: true } })
        : Promise.resolve([] as Array<{ postId: string }>),
    ]);
    const hiddenIds = new Set(hidden.map((h) => h.postId));
    const articleIds = rows.map((r) => r.articleId).filter((id): id is string => Boolean(id));
    const readingTimeByArticleId = new Map(
      articleIds.length > 0
        ? (await this.prisma.article.findMany({ where: { id: { in: articleIds } }, select: { id: true, body: true } })).map(
            (a) => [a.id, estimateReadingTimeMinutes(a.body)] as const,
          )
        : [],
    );

    return rows
      .filter((row) => row.boardThread)
      .map((row) => {
        const canAccess = this.canRead(viewer, row);
        const postDto = toPostDto(row as unknown as PostWithAuthorAndMedia, this.publicBaseUrl, {
          viewerHasBoosted: boosted.has(row.id),
          viewerHasBookmarked: bookmarks.has(row.id),
          viewerCanAccess: canAccess,
          ...(viewer ? { viewerHasViewed: lastSeen.has(row.id) } : {}),
        });
        const dto = toBoardThreadDto(postDto, row.boardThread!, {
          viewerCanAccess: canAccess,
          viewerHidden: hiddenIds.has(row.id),
          viewerCanEdit: this.canEdit(viewer, row),
          articleId: row.articleId ?? null,
        });
        if (viewer) dto.viewerLastSeenAt = lastSeen.get(row.id)?.toISOString() ?? null;
        const readingTime = canAccess && row.articleId ? readingTimeByArticleId.get(row.articleId) : undefined;
        if (readingTime) dto.readingTimeMinutes = readingTime;
        if (canAccess && !dto.image && row.article?.thumbnailR2Key) {
          const url = publicAssetUrl({ publicBaseUrl: this.publicBaseUrl, key: row.article.thumbnailR2Key });
          if (url) {
            dto.image = {
              id: `article-${row.article.id}`,
              kind: 'image',
              source: 'upload',
              url,
              mp4Url: null,
              thumbnailUrl: null,
              width: null,
              height: null,
              durationSeconds: null,
              alt: row.article.title,
              deletedAt: null,
            };
          }
        }
        return dto;
      });
  }

  async createThread(userId: string, input: BoardCreateThreadInput): Promise<BoardThreadDto> {
    const title = (input.title ?? '').trim().replace(/\s+/g, ' ');
    if (title.length < BOARD_TITLE_MIN) throw new BadRequestException(`Titles need at least ${BOARD_TITLE_MIN} characters.`);
    if (title.length > BOARD_TITLE_MAX) throw new BadRequestException(`Titles are limited to ${BOARD_TITLE_MAX} characters.`);

    const rawUrl = (input.url ?? '').trim();
    const link = rawUrl ? normalizeBoardUrl(rawUrl) : null;
    if (rawUrl && !link) throw new BadRequestException('Enter a valid http or https link.');

    const tags = normalizeBoardTags(input.tags);
    if (tags.length > BOARD_MAX_TAGS) throw new BadRequestException(`Add up to ${BOARD_MAX_TAGS} tags.`);

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await this.prisma.post.count({
      where: { userId, kind: 'board', parentId: null, createdAt: { gte: since } },
    });
    if (recent >= BOARD_THREADS_PER_HOUR) {
      throw new HttpException(`You can start up to ${BOARD_THREADS_PER_HOUR} Board posts an hour.`, HttpStatus.TOO_MANY_REQUESTS);
    }

    const { post } = await this.posts.createPost({
      userId,
      body: (input.body ?? '').trim(),
      visibility: input.visibility,
      kind: 'board',
      board: {
        title,
        url: link?.url ?? null,
        urlNormalized: link?.normalized ?? null,
        domain: link?.domain ?? null,
        tags,
        showInFeed: input.showInFeed,
      },
      media: input.image
        ? [{
            source: 'upload',
            kind: 'image',
            r2Key: input.image.r2Key,
            width: input.image.width ?? undefined,
            height: input.image.height ?? undefined,
            alt: input.image.alt,
          }]
        : null,
      poll: null,
      mentions: null,
    });

    await Promise.all([
      this.bumpTags(tags),
      this.prisma.user.update({ where: { id: userId }, data: { boardShareToFeedDefault: input.showInFeed } }),
    ]);
    this.realtime.emitBoardNewThread({ threadId: post.id, visibility: input.visibility, tags });
    this.sideEffects.dispatch('board.thread.tag', { threadId: post.id }, { jobId: `board-tag-${post.id}` });
    return this.getThread(userId, post.id);
  }

  /** Board thread created from an article publish. Title + article link only — body stays optional like other link posts. */
  async createArticleThread(params: {
    userId: string;
    article: { id: string; title: string; excerpt: string | null; visibility: PostVisibility; commentCount?: number };
    tags: string[];
    showInFeed: boolean;
  }): Promise<string | null> {
    const existing = await this.prisma.post.findFirst({
      where: { articleId: params.article.id, kind: 'board', parentId: null, deletedAt: null },
      select: { id: true },
    });
    if (existing) return existing.id;

    const base = (this.appConfig.frontendBaseUrl() ?? 'https://menofhunger.com').replace(/\/$/, '');
    const link = normalizeBoardUrl(`${base}/a/${params.article.id}`);
    const visibility = (params.article.visibility === 'onlyMe' ? 'verifiedOnly' : params.article.visibility) as BoardVisibility;
    const tags = normalizeBoardTags(params.tags).slice(0, BOARD_MAX_TAGS);
    const { post } = await this.posts.createPost({
      userId: params.userId,
      body: '',
      visibility,
      kind: 'board',
      articleId: params.article.id,
      board: {
        title: params.article.title.trim().slice(0, BOARD_TITLE_MAX),
        url: link?.url ?? null,
        urlNormalized: link?.normalized ?? null,
        domain: link?.domain ?? null,
        tags,
        showInFeed: params.showInFeed,
      },
      media: null,
      poll: null,
      mentions: null,
    });
    await this.bumpTags(tags);
    this.realtime.emitBoardNewThread({ threadId: post.id, visibility, tags });
    this.sideEffects.dispatch('board.thread.tag', { threadId: post.id }, { jobId: `board-tag-${post.id}` });
    return post.id;
  }

  /** Keeps article-sourced threads aligned when the article changes. Board comment counts stay on the Board. */
  async syncArticleThread(articleId: string, patch: { title?: string; visibility?: PostVisibility; commentCount?: number; deleted?: boolean }) {
    const threads = await this.prisma.post.findMany({
      where: { articleId, kind: 'board', parentId: null, deletedAt: null },
      select: { id: true },
    });
    if (threads.length === 0) return;
    const ids = threads.map((t) => t.id);
    if (patch.deleted) {
      await this.prisma.post.updateMany({ where: { id: { in: ids } }, data: { deletedAt: new Date() } });
      for (const id of ids) {
        this.realtime.emitPostsLiveUpdated(id, { postId: id, version: new Date().toISOString(), reason: 'post_deleted', patch: { deletedAt: new Date().toISOString() } });
      }
      return;
    }
    const postData: Prisma.PostUpdateManyMutationInput = {};
    if (patch.visibility && patch.visibility !== 'onlyMe') postData.visibility = patch.visibility;
    if (Object.keys(postData).length) await this.prisma.post.updateMany({ where: { id: { in: ids } }, data: postData });
    if (patch.title?.trim()) {
      await this.prisma.boardThread.updateMany({ where: { postId: { in: ids } }, data: { title: patch.title.trim().slice(0, BOARD_TITLE_MAX) } });
    }
    // Drop any previously mirrored article comment counts so the Board shows its own discussion.
    await this.repairArticleBoardCommentCounts(ids);
  }

  /** Set Board commentCount from live Board replies (not the article). */
  private async repairArticleBoardCommentCounts(threadIds: string[]): Promise<void> {
    for (const id of threadIds) {
      const commentCount = await this.prisma.post.count({
        where: { rootId: id, deletedAt: null, NOT: { id } },
      });
      await this.prisma.post.update({ where: { id }, data: { commentCount } });
    }
  }

  async updateThread(
    userId: string,
    threadId: string,
    input: { title?: string; url?: string | null; tags?: string[]; body?: string },
  ): Promise<BoardThreadDto> {
    const viewer = await this.viewerContext.getViewerOrThrow(userId);
    const row = await this.findThreadRow(threadId);
    if (row.userId !== userId && !viewer.siteAdmin) throw new ForbiddenException('Not allowed to edit this thread.');
    if (!this.canEdit(viewer, row)) throw new ForbiddenException('This post can no longer be edited.');

    const data: Prisma.BoardThreadUpdateInput = {};
    if (typeof input.title === 'string') {
      const title = input.title.trim().replace(/\s+/g, ' ');
      if (title.length < BOARD_TITLE_MIN || title.length > BOARD_TITLE_MAX) {
        throw new BadRequestException(`Titles need ${BOARD_TITLE_MIN}–${BOARD_TITLE_MAX} characters.`);
      }
      data.title = title;
    }
    if (input.url !== undefined && !row.articleId) {
      const raw = (input.url ?? '').trim();
      const link = raw ? normalizeBoardUrl(raw) : null;
      if (raw && !link) throw new BadRequestException('Enter a valid http or https link.');
      data.url = link?.url ?? null;
      data.urlNormalized = link?.normalized ?? null;
      data.domain = link?.domain ?? null;
    }
    if (Array.isArray(input.tags)) {
      const tags = normalizeBoardTags(input.tags);
      if (tags.length > BOARD_MAX_TAGS) throw new BadRequestException(`Add up to ${BOARD_MAX_TAGS} tags.`);
      const added = tags.filter((t) => !row.boardThread!.tags.includes(t));
      data.tags = tags;
      await this.bumpTags(added);
    }

    const nextBody = typeof input.body === 'string' ? input.body.trim() : null;
    if (nextBody !== null && nextBody !== row.body && nextBody) {
      await this.posts.updatePost({ userId: row.userId, postId: row.id, body: nextBody, isSiteAdmin: viewer.siteAdmin });
    } else if (Object.keys(data).length) {
      await this.prisma.post.update({
        where: { id: row.id },
        data: { editedAt: new Date(), editCount: { increment: 1 } },
      });
    }
    if (Object.keys(data).length) {
      await this.prisma.boardThread.update({ where: { postId: row.id }, data });
    }
    this.realtime.emitPostsLiveUpdated(row.id, {
      postId: row.id,
      version: new Date().toISOString(),
      reason: 'post_edited',
      patch: {},
    });
    const contentChanged = typeof input.title === 'string' || input.url !== undefined || (nextBody !== null && nextBody !== row.body);
    if (contentChanged && !Array.isArray(input.tags)) {
      this.sideEffects.dispatch('board.thread.tag', { threadId: row.id });
    }
    return this.getThread(userId, row.id);
  }

  async deletePost(userId: string, postId: string) {
    const row = await this.prisma.post.findFirst({ where: { id: postId, kind: 'board' }, select: { id: true } });
    if (!row) throw new NotFoundException('Not found.');
    return this.posts.deletePost({ userId, postId });
  }

  async setHidden(userId: string, threadId: string, hidden: boolean) {
    await this.findThreadRow(threadId);
    if (hidden) {
      await this.prisma.boardHide.upsert({
        where: { userId_postId: { userId, postId: threadId } },
        create: { userId, postId: threadId },
        update: {},
      });
    } else {
      await this.prisma.boardHide.deleteMany({ where: { userId, postId: threadId } });
    }
    return { hidden };
  }

  // ─── Comments ───────────────────────────────────────────────────────────────

  async listComments(viewerUserId: string | null, threadId: string, sort: 'top' | 'new'): Promise<BoardCommentsPageDto> {
    const viewer = await this.viewerContext.getViewer(viewerUserId);
    const root = await this.findThreadRow(threadId);
    if (!this.canRead(viewer, root)) return { viewerCanAccess: false, comments: [] };
    const tree = await this.loadCommentTree(viewer, root.id, sort);
    return { viewerCanAccess: true, comments: tree.roots };
  }

  async getCommentContext(viewerUserId: string | null, commentId: string): Promise<BoardCommentContextDto> {
    const id = (commentId ?? '').trim();
    const row = id
      ? await this.prisma.post.findFirst({
          where: { id, kind: 'board', parentId: { not: null } },
          select: { id: true, rootId: true, parentId: true },
        })
      : null;
    if (!row) throw new NotFoundException('Comment not found.');
    const threadId = row.rootId ?? row.parentId!;
    const viewer = await this.viewerContext.getViewer(viewerUserId);
    const thread = await this.getThread(viewerUserId, threadId);
    if (!thread.viewerCanAccess) return { thread, ancestors: [], comment: null };

    const tree = await this.loadCommentTree(viewer, threadId, 'top');
    const node = tree.byId.get(id);
    if (!node) throw new NotFoundException('Comment not found.');
    const ancestors: BoardCommentDto[] = [];
    let parentId = node.parentId;
    while (parentId) {
      const parent = tree.byId.get(parentId);
      if (!parent) break;
      ancestors.unshift({ ...parent, replies: [] });
      parentId = parent.parentId;
    }
    return { thread, ancestors, comment: node };
  }

  private async loadCommentTree(viewer: ViewerContext | null, threadId: string, sort: 'top' | 'new') {
    const rows: CommentRow[] = await this.prisma.post.findMany({
      where: { rootId: threadId, kind: 'board' },
      include: POST_BASE_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: BOARD_COMMENTS_MAX_ROWS,
    });
    const boosted = viewer
      ? await this.posts.viewerBoostedPostIds({ viewerUserId: viewer.id, postIds: rows.map((r) => r.id) })
      : new Set<string>();

    const childrenOf = new Map<string, CommentRow[]>();
    for (const r of rows) {
      const key = r.parentId ?? threadId;
      const list = childrenOf.get(key) ?? [];
      list.push(r);
      childrenOf.set(key, list);
    }
    const now = new Date();
    const byId = new Map<string, BoardCommentDto>();
    const build = (parentId: string, depth: number): BoardCommentDto[] => {
      const kids = [...(childrenOf.get(parentId) ?? [])];
      kids.sort((a, b) =>
        sort === 'new'
          ? b.createdAt.getTime() - a.createdAt.getTime()
          : boardHotScore(b.boostCount, b.createdAt, now) - boardHotScore(a.boostCount, a.createdAt, now) ||
            a.createdAt.getTime() - b.createdAt.getTime(),
      );
      const out: BoardCommentDto[] = [];
      for (const r of kids) {
        const replies = build(r.id, depth + 1);
        if (r.deletedAt && replies.length === 0) continue;
        const dto = toBoardCommentDto(
          toPostDto(r as unknown as PostWithAuthorAndMedia, this.publicBaseUrl, { viewerHasBoosted: boosted.has(r.id) }),
          { threadId, depth },
        );
        dto.replies = replies;
        byId.set(dto.id, dto);
        out.push(dto);
      }
      return out;
    };
    return { roots: build(threadId, 0), byId };
  }

  async createComment(userId: string, threadId: string, input: { body: string; parentId: string | null }): Promise<BoardCommentDto> {
    const root = await this.findThreadRow(threadId);
    const body = (input.body ?? '').trim();
    if (!body) throw new BadRequestException('Write a comment first.');
    let parentId = root.id;
    let depth = 0;
    if (input.parentId && input.parentId !== root.id) {
      const parent = await this.prisma.post.findFirst({
        where: { id: input.parentId, rootId: root.id, kind: 'board', deletedAt: null },
        select: { id: true },
      });
      if (!parent) throw new NotFoundException('Comment not found.');
      parentId = parent.id;
      depth = await this.depthOf(parent.id, root.id);
    }
    const { post } = await this.posts.createPost({
      userId,
      body,
      visibility: root.visibility,
      parentId,
      kind: 'board',
      media: null,
      poll: null,
      mentions: null,
    });
    return toBoardCommentDto(
      toPostDto(post as unknown as PostWithAuthorAndMedia, this.publicBaseUrl, { viewerHasBoosted: false }),
      { threadId: root.id, depth },
    );
  }

  private async depthOf(commentId: string, threadId: string): Promise<number> {
    let depth = 1;
    let current: string | null = commentId;
    for (let i = 0; i < 64 && current; i++) {
      const row: { parentId: string | null } | null = await this.prisma.post.findUnique({ where: { id: current }, select: { parentId: true } });
      if (!row?.parentId || row.parentId === threadId) return depth;
      depth++;
      current = row.parentId;
    }
    return depth;
  }

  /** Newest comments across the Board (or by one member), limited to threads the viewer can read. */
  async listLatestComments(params: {
    viewerUserId: string | null;
    authorUsername: string | null;
    limit: number;
    cursor: string | null;
  }): Promise<{ comments: BoardCommentDto[]; nextCursor: string | null }> {
    const viewer = await this.viewerContext.getViewer(params.viewerUserId);
    const limit = Math.max(1, Math.min(50, params.limit));
    const authorUsername = (params.authorUsername ?? '').trim();
    const readable = this.readableVisibilities(viewer);
    const where: Prisma.PostWhereInput = {
      kind: 'board',
      parentId: { not: null },
      deletedAt: null,
      user: authorUsername
        ? { bannedAt: null, username: { equals: authorUsername, mode: 'insensitive' } }
        : { bannedAt: null },
      OR: [{ visibility: { in: readable } }, ...(viewer ? [{ userId: viewer.id }] : [])],
      root: { is: { deletedAt: null } },
    };
    const cursorWhere = await createdAtIdCursorWhere({
      cursor: params.cursor,
      lookup: (id) => this.prisma.post.findUnique({ where: { id }, select: { id: true, createdAt: true } }),
    });
    let rows = await this.prisma.post.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      include: {
        ...POST_BASE_INCLUDE,
        root: { select: { id: true, visibility: true, boardThread: { select: { title: true } } } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    let nextCursor: string | null = null;
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      nextCursor = rows[rows.length - 1]?.id ?? null;
    }
    const boosted = viewer
      ? await this.posts.viewerBoostedPostIds({ viewerUserId: viewer.id, postIds: rows.map((r) => r.id) })
      : new Set<string>();
    const comments = rows
      .filter((r) => r.root?.boardThread)
      .map((r) =>
        toBoardCommentDto(
          toPostDto(r as unknown as PostWithAuthorAndMedia, this.publicBaseUrl, { viewerHasBoosted: boosted.has(r.id) }),
          {
            threadId: r.root!.id,
            depth: 0,
            thread: {
              id: r.root!.id,
              title: r.root!.boardThread!.title,
              visibility: r.root!.visibility as BoardVisibility,
            },
          },
        ),
      );
    return { comments, nextCursor };
  }

  // ─── Tags, duplicates, preferences ─────────────────────────────────────────

  private async bumpTags(tags: string[]) {
    const now = new Date();
    await Promise.all(
      tags.map((slug) =>
        this.prisma.boardTag.upsert({
          where: { slug },
          create: { slug, label: slug, threadCount: 1, lastUsedAt: now },
          update: { threadCount: { increment: 1 }, lastUsedAt: now },
        }),
      ),
    );
  }

  async leaderboard(viewerUserId: string | null, limit: number): Promise<BoardLeaderboardDto> {
    const take = Math.max(1, Math.min(50, limit));
    const eligible = Prisma.sql`
      FROM "Post" p
      JOIN "User" u ON u.id = p."userId"
      WHERE p."kind" = 'board' AND p."deletedAt" IS NULL AND p."isDraft" = false
        AND u."bannedAt" IS NULL AND u."isBot" = false
    `;
    const top = await this.prisma.$queryRaw<Array<{ user_id: string; points: number }>>(Prisma.sql`
      SELECT p."userId" AS user_id, SUM(p."boostCount")::int AS points
      ${eligible}
      GROUP BY p."userId"
      HAVING SUM(p."boostCount") > 0
      ORDER BY points DESC, p."userId" ASC
      LIMIT ${take}
    `);

    let viewer: { rank: number; points: number } | null = null;
    if (viewerUserId && !top.some((r) => r.user_id === viewerUserId)) {
      const [mine] = await this.prisma.$queryRaw<Array<{ points: number }>>(Prisma.sql`
        SELECT COALESCE(SUM(p."boostCount"), 0)::int AS points ${eligible} AND p."userId" = ${viewerUserId}
      `);
      const points = mine?.points ?? 0;
      if (points > 0) {
        const [ahead] = await this.prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
          SELECT COUNT(*)::int AS n FROM (
            SELECT p."userId" ${eligible} GROUP BY p."userId" HAVING SUM(p."boostCount") > ${points}
          ) ranked
        `);
        viewer = { rank: (ahead?.n ?? 0) + 1, points };
      }
    }

    const ids = [...top.map((r) => r.user_id), ...(viewer && viewerUserId ? [viewerUserId] : [])];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: USER_LIST_SELECT });
    const byId = new Map(users.map((u) => [u.id, u]));
    const toRow = (id: string, points: number): BoardLeaderboardUserDto | null => {
      const u = byId.get(id);
      return u ? { ...toUserListDto(u, this.publicBaseUrl), boardPoints: points } : null;
    };
    const viewerRow = viewer && viewerUserId ? toRow(viewerUserId, viewer.points) : null;
    return {
      users: top.map((r) => toRow(r.user_id, r.points)).filter((r): r is BoardLeaderboardUserDto => Boolean(r)),
      viewerRank: viewer && viewerRow ? { rank: viewer.rank, user: viewerRow } : null,
      generatedAt: new Date().toISOString(),
    };
  }

  async listTags(q: string | null, limit: number): Promise<BoardTagDto[]> {
    const prefix = slugifyBoardTag(q ?? '') ?? '';
    const rows = await this.prisma.boardTag.findMany({
      where: prefix ? { slug: { startsWith: prefix } } : { threadCount: { gt: 0 } },
      orderBy: [{ threadCount: 'desc' }, { slug: 'asc' }],
      take: Math.max(1, Math.min(30, limit)),
      select: { slug: true, label: true, threadCount: true },
    });
    if (prefix) return rows;
    const seeded = BOARD_SEED_TAGS.filter((s) => !rows.some((r) => r.slug === s)).map((slug) => ({ slug, label: slug, threadCount: 0 }));
    return [...seeded, ...rows];
  }

  async findDuplicate(viewerUserId: string | null, rawUrl: string): Promise<BoardThreadDto | null> {
    const link = normalizeBoardUrl(rawUrl);
    if (!link) return null;
    const since = new Date(Date.now() - BOARD_DUPLICATE_WINDOW_DAYS * 86_400_000);
    const row = await this.prisma.post.findFirst({
      where: {
        kind: 'board',
        parentId: null,
        deletedAt: null,
        createdAt: { gte: since },
        boardThread: { is: { urlNormalized: link.normalized } },
      },
      include: POST_LIST_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return null;
    const viewer = await this.viewerContext.getViewer(viewerUserId);
    const [dto] = await this.hydrateThreads(viewer, [row]);
    return dto ?? null;
  }

  async getPreferences(userId: string): Promise<BoardPreferencesDto> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { boardShareToFeedDefault: true, articlePostToBoardDefault: true },
    });
    if (!u) throw new NotFoundException('User not found.');
    return { shareToFeedDefault: u.boardShareToFeedDefault, articlePostToBoardDefault: u.articlePostToBoardDefault };
  }

  async updatePreferences(userId: string, patch: Partial<BoardPreferencesDto>): Promise<BoardPreferencesDto> {
    const u = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(typeof patch.shareToFeedDefault === 'boolean' ? { boardShareToFeedDefault: patch.shareToFeedDefault } : {}),
        ...(typeof patch.articlePostToBoardDefault === 'boolean' ? { articlePostToBoardDefault: patch.articlePostToBoardDefault } : {}),
      },
      select: { boardShareToFeedDefault: true, articlePostToBoardDefault: true },
    });
    return { shareToFeedDefault: u.boardShareToFeedDefault, articlePostToBoardDefault: u.articlePostToBoardDefault };
  }
}
