import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../app/app-config.service';
import { LinkMetadataService } from '../../link-metadata/link-metadata.service';
import { MarvinAIService } from './marvin-ai.service';
import { fillVisionSlots, marvMediaMarker, resolveMarvVisionUrl } from './marvin-vision-media';
import { marvPublicProfilePostWhere } from './marvin-post-access';

export type GeneratedContextCard = {
  cardText: string;
  source: 'generated' | 'manual' | 'hybrid' | 'fallback';
};

const CARD_MAX_LENGTH = 1_200;
const RECENT_POSTS_LIMIT = 12;
const RECENT_ARTICLES_LIMIT = 10;
const SENSITIVE_TERMS = [
  'phone',
  'address',
  'ssn',
  'passport',
  'license',
  'medical',
  'doctor',
  'diagnosis',
  'medication',
  'therapy',
  'addict',
  'depress',
  'suicid',
  'self-harm',
];

type CardPost = {
  body: string;
  createdAt: Date;
  media: Array<{
    kind: string;
    source: string;
    r2Key: string | null;
    url: string | null;
    thumbnailR2Key: string | null;
  }>;
  poll: {
    totalVoteCount: number;
    endsAt: Date | null;
    options: Array<{ text: string; voteCount: number }>;
  } | null;
};

type CardArticle = { title: string; excerpt: string };

/**
 * Generates and persists per-user "context cards" — short, public-only summaries
 * Marv can fetch via the `get_user_context_card` tool to ground replies in who
 * the user is on the platform.
 *
 * Refresh is activity-based: new public posts/articles since the last card, not a
 * calendar TTL. When a card already exists, the model folds the new activity into
 * it rather than rewriting from scratch.
 *
 * SAFETY:
 *  - Source data is restricted to public profile + PUBLIC posts/articles that are
 *    not in a community group. Group posts (including private/approval groups) are
 *    members-only even when visibility is `public`. Direct messages, only-me,
 *    premium-only, and verified-only posts are excluded.
 *  - Sensitive terms are redacted post-generation.
 */
@Injectable()
export class MarvinContextCardService {
  private readonly logger = new Logger(MarvinContextCardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: MarvinAIService,
    private readonly appConfig: AppConfigService,
    private readonly linkMetadata: LinkMetadataService,
  ) {}

  async getCardText(username: string): Promise<string | null> {
    const u = (username ?? '').trim().toLowerCase();
    if (!u) return null;
    const user = await this.prisma.user.findFirst({
      where: { username: { equals: u, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!user) return null;
    const card = await this.prisma.userContextCard.findUnique({
      where: { userId: user.id },
      select: { cardText: true },
    });
    return card?.cardText ?? null;
  }

  /**
   * Cheap profile-only card for a tool miss while the real generation job runs.
   * Does not persist and does not call the model.
   */
  async peekFallbackCard(userId: string): Promise<string | null> {
    const user = await this.loadUser(userId);
    if (!user) return null;
    const [followerCount, followingCount] = await this.followCounts(user.id);
    return buildFallbackCard({
      displayName: user.name ?? user.username ?? 'a member',
      username: user.username ?? '',
      bio: (user.bio ?? '').trim(),
      interests: user.interests ?? [],
      isPremium: Boolean(user.premium || user.premiumPlus),
      isOrganization: Boolean(user.isOrganization),
      followerCount,
      followingCount,
      memberSince: user.createdAt,
      articleCount: 0,
    });
  }

  /**
   * Generate (or incrementally refresh) a context card for one user.
   * `forceFull` rebuilds from the recent public window even when nothing new landed
   * (admin regenerate).
   */
  async refreshCardForUser(userId: string, opts?: { forceFull?: boolean }): Promise<string | null> {
    const user = await this.loadUser(userId);
    if (!user) return null;

    const existing = await this.prisma.userContextCard.findUnique({
      where: { userId: user.id },
      select: { cardText: true, source: true, updatedAt: true },
    });

    const incremental = Boolean(existing?.cardText) && !opts?.forceFull;
    const since = incremental ? existing!.updatedAt : null;

    const [recentPosts, recentArticles, followerCount, followingCount] = await Promise.all([
      this.loadPublicPosts(user.id, since),
      this.loadPublicArticles(user.id, since),
      ...this.followCountPromises(user.id),
    ]);

    if (incremental && recentPosts.length === 0 && recentArticles.length === 0) {
      return existing!.cardText;
    }

    const fallback = buildFallbackCard({
      displayName: user.name ?? user.username ?? 'a member',
      username: user.username ?? '',
      bio: (user.bio ?? '').trim(),
      interests: user.interests ?? [],
      isPremium: Boolean(user.premium || user.premiumPlus),
      isOrganization: Boolean(user.isOrganization),
      followerCount,
      followingCount,
      memberSince: user.createdAt,
      articleCount: recentArticles.length,
    });

    let cardText = incremental ? existing!.cardText : fallback;
    let source: GeneratedContextCard['source'] = incremental ? 'generated' : 'fallback';

    if (this.ai.isConfigured()) {
      try {
        const generated = await this.generateWithAI({
          username: user.username ?? '',
          displayName: user.name ?? user.username ?? '',
          bio: (user.bio ?? '').trim(),
          interests: user.interests ?? [],
          previousCard: incremental ? existing!.cardText : null,
          posts: recentPosts,
          articles: recentArticles,
          isPremium: Boolean(user.premium || user.premiumPlus),
          followerCount,
          followingCount,
        });
        if (generated) {
          cardText = generated;
          source = 'generated';
        }
      } catch (err) {
        this.logger.warn(
          `[marv] context card AI generation failed for user=${user.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        if (incremental) return existing!.cardText;
      }
    }

    cardText = redactSensitive(cardText).slice(0, CARD_MAX_LENGTH).trim();
    if (!cardText) cardText = fallback;

    await this.prisma.userContextCard.upsert({
      where: { userId: user.id },
      update: { cardText, source },
      create: { userId: user.id, cardText, source },
    });
    return cardText;
  }

  /**
   * Users who need a card: none yet, or new public posts/articles since the last write.
   */
  async listUsersNeedingCardRefresh(take = 100): Promise<string[]> {
    const limit = Math.max(1, Math.min(500, take));
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT u.id
      FROM "User" u
      LEFT JOIN "UserContextCard" c ON c."userId" = u.id
      WHERE u."isBot" = false
        AND u."bannedAt" IS NULL
        AND (
          c.id IS NULL
          OR EXISTS (
            SELECT 1 FROM "Post" p
            WHERE p."userId" = u.id
              AND p."deletedAt" IS NULL
              AND p.visibility::text = 'public'
              AND p."communityGroupId" IS NULL
              AND p."createdAt" > c."updatedAt"
          )
          OR EXISTS (
            SELECT 1 FROM "Article" a
            WHERE a."authorId" = u.id
              AND a."deletedAt" IS NULL
              AND a."isDraft" = false
              AND a.visibility::text = 'public'
              AND a."publishedAt" IS NOT NULL
              AND a."publishedAt" > c."updatedAt"
          )
        )
      ORDER BY u."createdAt" ASC
      LIMIT ${limit}
    `);
    return rows.map((r) => r.id);
  }

  private async loadUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        name: true,
        bio: true,
        interests: true,
        premium: true,
        premiumPlus: true,
        isOrganization: true,
        verifiedStatus: true,
        createdAt: true,
        isBot: true,
      },
    });
    if (!user || user.isBot) return null;
    return user;
  }

  private followCountPromises(userId: string): [Promise<number>, Promise<number>] {
    return [
      this.prisma.follow.count({ where: { followingId: userId } }),
      this.prisma.follow.count({ where: { followerId: userId } }),
    ];
  }

  private async followCounts(userId: string): Promise<[number, number]> {
    return Promise.all(this.followCountPromises(userId));
  }

  private async loadPublicPosts(userId: string, since: Date | null): Promise<CardPost[]> {
    return this.prisma.post.findMany({
      where: {
        userId,
        deletedAt: null,
        visibility: 'public',
        ...marvPublicProfilePostWhere(),
        ...(since ? { createdAt: { gt: since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: RECENT_POSTS_LIMIT,
      select: {
        body: true,
        createdAt: true,
        media: {
          where: { deletedAt: null },
          select: { kind: true, source: true, r2Key: true, url: true, thumbnailR2Key: true, position: true },
          orderBy: { position: 'asc' },
        },
        poll: {
          select: {
            totalVoteCount: true,
            endsAt: true,
            options: { select: { text: true, voteCount: true }, orderBy: { position: 'asc' } },
          },
        },
      },
    });
  }

  private async loadPublicArticles(userId: string, since: Date | null): Promise<CardArticle[]> {
    const rows = await this.prisma.article.findMany({
      where: {
        authorId: userId,
        deletedAt: null,
        isDraft: false,
        visibility: 'public',
        publishedAt: since ? { gt: since } : { not: null },
      },
      orderBy: { publishedAt: 'desc' },
      take: RECENT_ARTICLES_LIMIT,
      select: { title: true, excerpt: true, publishedAt: true },
    });
    return rows
      .map((a) => ({ title: (a.title ?? '').trim(), excerpt: (a.excerpt ?? '').trim() }))
      .filter((a) => a.title);
  }

  private async generateWithAI(input: {
    username: string;
    displayName: string;
    bio: string;
    interests: string[];
    previousCard: string | null;
    posts: CardPost[];
    articles: CardArticle[];
    isPremium: boolean;
    followerCount: number;
    followingCount: number;
  }): Promise<string | null> {
    const openAICfg = this.appConfig.marvOpenAI();
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const postImageUrls: string[] = [];
    for (const post of input.posts) {
      for (const m of post.media) {
        const url = resolveMarvVisionUrl(m, publicBaseUrl);
        if (url) postImageUrls.push(url);
      }
    }
    const previewBodies = input.posts.map((p) => p.body).filter(Boolean).join('\n');
    const linkPreviews = await this.linkMetadata.previewLinks(previewBodies).catch(() => []);
    let imageUrls = fillVisionSlots(
      postImageUrls,
      linkPreviews.map((p) => p.imageUrl),
      openAICfg.visionMaxImagesPerTurn,
    );

    let mode: 'fast' | 'regular' | 'smart' = 'fast';
    if (imageUrls.length > 0 && openAICfg.visionEnabled && !openAICfg.visionModes.includes(mode)) {
      const visionTier = (['regular', 'smart', 'fast'] as const).find((m) => openAICfg.visionModes.includes(m));
      if (visionTier) mode = visionTier;
    }
    const visionActive = openAICfg.visionEnabled && openAICfg.visionModes.includes(mode);
    if (!visionActive) imageUrls = [];

    const folding = Boolean(input.previousCard);
    const developerNote = [
      'You are summarizing a user for a friendly AI helper named Marv.',
      folding
        ? 'Goal: rewrite their existing card to fold in the NEW public activity below. Keep lasting themes; add concrete new details; drop what no longer fits. 80-140 words.'
        : 'Goal: 80-140 words describing how this person tends to show up here — themes, tone, what they care about, what they post and share.',
      'Use ONLY the public profile, public posts (including images, GIFs, video posters, polls, and link previews), and public articles provided. Do NOT speculate beyond what is given.',
      'Do NOT include phone numbers, addresses, financial details, medical details, or anything that could identify them off-platform.',
      'Do NOT mention private DMs (you do not have access to any).',
      "Avoid praise, judgement, or labels (don't say 'leader' / 'great guy' / 'should').",
      'Output plain prose only — no headings, no bullet lists.',
    ].join(' ');

    const userMessage = [
      `Username: @${input.username}`,
      `Display name: ${input.displayName || '—'}`,
      `Bio: ${input.bio || '—'}`,
      input.interests.length ? `Interests: ${input.interests.join(', ')}` : '',
      `Followers: ${input.followerCount}, following: ${input.followingCount}.`,
      `Premium: ${input.isPremium ? 'yes' : 'no'}`,
      folding ? `Existing card:\n${input.previousCard}` : '',
      input.posts.length
        ? `${folding ? 'New public posts' : 'Recent public posts'}:\n${input.posts
            .map((p) => `- ${formatPostLine(p)}`)
            .join('\n')}`
        : folding
          ? 'New public posts: none'
          : 'Recent public posts: none',
      input.articles.length
        ? `${folding ? 'New public articles' : 'Public articles'} (title + excerpt):\n${input.articles
            .slice(0, 5)
            .map((a) => `- "${a.title}"${a.excerpt ? `: ${truncate(a.excerpt, 200)}` : ''}`)
            .join('\n')}`
        : '',
      linkPreviews.length
        ? `Link previews:\n${linkPreviews
            .map((lp) => {
              const site = lp.siteName ? ` — ${lp.siteName}` : '';
              const desc = lp.description ? ` — ${truncate(lp.description, 120)}` : '';
              const img = lp.imageUrl ? ' [preview image attached]' : '';
              return `- "${lp.title ?? lp.url}"${site}${desc}${img}`;
            })
            .join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const result = await this.ai.respond({
      source: 'public_thread',
      mode,
      developerNote,
      userMessage,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      dispatchTool: async () => '{}',
      toolContext: { requesterUserId: '' },
      previousResponseId: null,
      cacheKey: 'marv:context-card',
    });
    const text = (result.text ?? '').trim();
    return text || null;
  }
}

function formatPostLine(p: CardPost): string {
  const body = truncate((p.body ?? '').trim(), 240) || '(no text)';
  const poll = p.poll
    ? ` [poll: ${p.poll.options.map((o) => `${o.text} (${o.voteCount})`).join(', ')}]`
    : '';
  return `"${body}"${marvMediaMarker(p.media)}${poll}`;
}

function buildFallbackCard(input: {
  displayName: string;
  username: string;
  bio: string;
  interests: string[];
  isPremium: boolean;
  isOrganization: boolean;
  followerCount: number;
  followingCount: number;
  memberSince: Date;
  articleCount: number;
}): string {
  const tier = input.isOrganization ? 'organization' : input.isPremium ? 'premium member' : 'member';
  const monthsAgo = Math.max(
    0,
    Math.floor((Date.now() - input.memberSince.getTime()) / (30 * 24 * 60 * 60 * 1000)),
  );
  const tenure = monthsAgo === 0 ? 'recently joined' : `${monthsAgo} months on the platform`;
  const bioLine = input.bio ? ` Bio: ${truncate(input.bio, 200)}.` : '';
  const interestsLine = input.interests.length ? ` Interests: ${input.interests.slice(0, 8).join(', ')}.` : '';
  const articlesLine =
    input.articleCount > 0
      ? ` Has published ${input.articleCount} public article${input.articleCount === 1 ? '' : 's'}.`
      : '';
  return (
    `@${input.username || 'member'} (${input.displayName}) is a ${tier}, ` +
    `${tenure}. ${input.followerCount} followers, ${input.followingCount} following.${bioLine}${interestsLine}${articlesLine}`
  ).trim();
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function redactSensitive(s: string): string {
  if (!s) return s;
  let out = s;
  out = out.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[redacted]');
  out = out.replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[redacted]');
  for (const term of SENSITIVE_TERMS) {
    const re = new RegExp(`[^.!?]*\\b${term}[a-z]*\\b[^.!?]*[.!?]?`, 'gi');
    out = out.replace(re, '');
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}
