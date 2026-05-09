import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../app/app-config.service';
import { MarvinAIService } from './marvin-ai.service';

export type GeneratedContextCard = {
  cardText: string;
  source: 'generated' | 'manual' | 'hybrid';
};

const CARD_MAX_LENGTH = 800;
const RECENT_POSTS_LIMIT = 30;
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

/**
 * Generates and persists per-user "context cards" — short, public-only summaries
 * Marv can fetch via the `get_user_context_card` tool to ground replies in who
 * the user is on the platform.
 *
 * SAFETY (per the plan):
 *  - Source data is restricted to public profile + last 30 PUBLIC posts.
 *    Direct messages, only-me posts, premium-only / verified-only posts are
 *    excluded by `where.visibility = 'public'`.
 *  - Sensitive terms (medical, financial, contact-detail keywords) are
 *    redacted from the card text post-generation. We err on the side of "lose
 *    a useful detail" rather than "leak something private".
 *  - When OpenAI isn't configured we still write a deterministic fallback card
 *    (display name + bio + tier) so the tool never returns null for active
 *    users — keeps replies grounded even in offline-AI environments.
 */
@Injectable()
export class MarvinContextCardService {
  private readonly logger = new Logger(MarvinContextCardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly ai: MarvinAIService,
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
   * Generate (or refresh) a context card for one user. Returns the persisted
   * row's `cardText` on success. Safe to call repeatedly — the latest card is
   * always upserted.
   */
  async refreshCardForUser(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        name: true,
        bio: true,
        premium: true,
        premiumPlus: true,
        isOrganization: true,
        verifiedStatus: true,
        createdAt: true,
        isBot: true,
      },
    });
    if (!user) return null;
    if (user.isBot) {
      // Don't generate cards for bot accounts (Marv himself, etc.) — pointless.
      return null;
    }

    // Only public posts — verifiedOnly, premiumOnly, and onlyMe are intentionally excluded.
    const recentPosts = await this.prisma.post.findMany({
      where: {
        userId: user.id,
        deletedAt: null,
        visibility: 'public',
      },
      orderBy: { createdAt: 'desc' },
      take: RECENT_POSTS_LIMIT,
      select: { body: true, createdAt: true },
    });

    // Public published articles — body is Tiptap JSON so we use title + excerpt only.
    const recentArticles = await this.prisma.article.findMany({
      where: {
        authorId: user.id,
        deletedAt: null,
        isDraft: false,
        visibility: 'public',
        publishedAt: { not: null },
      },
      orderBy: { publishedAt: 'desc' },
      take: RECENT_ARTICLES_LIMIT,
      select: { title: true, excerpt: true, publishedAt: true },
    });

    const [followerCount, followingCount] = await Promise.all([
      this.prisma.follow.count({ where: { followingId: user.id } }),
      this.prisma.follow.count({ where: { followerId: user.id } }),
    ]);

    const fallback = buildFallbackCard({
      displayName: user.name ?? user.username ?? 'a member',
      username: user.username ?? '',
      bio: (user.bio ?? '').trim(),
      isPremium: Boolean(user.premium || user.premiumPlus),
      isOrganization: Boolean(user.isOrganization),
      followerCount,
      followingCount,
      memberSince: user.createdAt,
      articleCount: recentArticles.length,
    });

    let cardText = fallback;
    let source: GeneratedContextCard['source'] = 'generated';
    if (this.ai.isConfigured()) {
      try {
        const generated = await this.generateWithAI({
          username: user.username ?? '',
          displayName: user.name ?? user.username ?? '',
          bio: (user.bio ?? '').trim(),
          recentBodies: recentPosts.map((p) => (p.body ?? '').trim()).filter(Boolean),
          recentArticles: recentArticles.map((a) => ({
            title: (a.title ?? '').trim(),
            excerpt: (a.excerpt ?? '').trim(),
          })).filter((a) => a.title),
          isPremium: Boolean(user.premium || user.premiumPlus),
          followerCount,
          followingCount,
        });
        if (generated) {
          cardText = generated;
        }
      } catch (err) {
        this.logger.warn(
          `[marv] context card AI generation failed for user=${user.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      source = 'generated';
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
   * Returns the user ids that need a fresh context card. We refresh when:
   *  - the row is missing, OR
   *  - `updatedAt` is older than `staleAfterDays`.
   *
   * Bots and banned users are excluded.
   */
  async listStaleCardUserIds(staleAfterDays = 30, take = 100): Promise<string[]> {
    const cutoff = new Date(Date.now() - staleAfterDays * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.user.findMany({
      where: {
        isBot: false,
        bannedAt: null,
        OR: [
          { contextCard: null },
          { contextCard: { updatedAt: { lt: cutoff } } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async generateWithAI(input: {
    username: string;
    displayName: string;
    bio: string;
    recentBodies: string[];
    recentArticles: Array<{ title: string; excerpt: string }>;
    isPremium: boolean;
    followerCount: number;
    followingCount: number;
  }): Promise<string | null> {
    const developerNote = [
      'You are summarizing a user for a friendly AI helper named Marv.',
      'Goal: 60-100 words describing how this person tends to show up here — themes, tone, what they care about.',
      'Use ONLY the public profile, public posts, and public articles provided. Do NOT speculate beyond what is given.',
      'Do NOT include phone numbers, addresses, financial details, medical details, or anything that could identify them off-platform.',
      'Do NOT mention private DMs (you do not have access to any).',
      "Avoid praise, judgement, or labels (don't say 'leader' / 'great guy' / 'should').",
      'Output plain prose only — no headings, no bullet lists.',
    ].join(' ');

    const userMessage = [
      `Username: @${input.username}`,
      `Display name: ${input.displayName || '—'}`,
      `Bio: ${input.bio || '—'}`,
      `Followers: ${input.followerCount}, following: ${input.followingCount}.`,
      `Premium: ${input.isPremium ? 'yes' : 'no'}`,
      input.recentBodies.length
        ? `Recent public posts:\n${input.recentBodies.slice(0, 12).map((b) => `- ${truncate(b, 240)}`).join('\n')}`
        : 'Recent public posts: none',
      input.recentArticles.length
        ? `Public articles (title + excerpt):\n${input.recentArticles
            .slice(0, 5)
            .map((a) => `- "${a.title}"${a.excerpt ? `: ${truncate(a.excerpt, 200)}` : ''}`)
            .join('\n')}`
        : '',
    ].filter(Boolean).join('\n');

    const result = await this.ai.respond({
      source: 'public_thread',
      mode: 'fast',
      developerNote,
      userMessage,
      // The card generator is self-contained on the data we already passed in;
      // any tool the model tries to call returns the empty payload, so the
      // model converges on text-only output within the standard tool-loop cap.
      dispatchTool: async () => '{}',
      toolContext: { requesterUserId: '' },
      previousResponseId: null,
      cacheKey: 'marv:context-card',
    });
    const text = (result.text ?? '').trim();
    return text || null;
  }
}

function buildFallbackCard(input: {
  displayName: string;
  username: string;
  bio: string;
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
  const articlesLine = input.articleCount > 0 ? ` Has published ${input.articleCount} public article${input.articleCount === 1 ? '' : 's'}.` : '';
  return (
    `@${input.username || 'member'} (${input.displayName}) is a ${tier}, ` +
    `${tenure}. ${input.followerCount} followers, ${input.followingCount} following.${bioLine}${articlesLine}`
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
  // Emails and phone-like sequences.
  out = out.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[redacted]');
  out = out.replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[redacted]');
  // Sensitive vocabulary — strip whole sentences containing the term.
  for (const term of SENSITIVE_TERMS) {
    const re = new RegExp(`[^.!?]*\\b${term}[a-z]*\\b[^.!?]*[.!?]?`, 'gi');
    out = out.replace(re, '');
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}
