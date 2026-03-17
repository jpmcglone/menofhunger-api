import type { Article, ArticleComment, ArticleBoost, ArticleReaction, ArticleCommentReaction, ArticleTag, PostVisibility, VerifiedStatus } from '@prisma/client';
import { publicAssetUrl } from '../assets/public-asset-url';
import type { PostAuthorRow } from './post.dto';

// ─── Reaction summary ────────────────────────────────────────────────────────

export type ArticleReactionSummaryDto = {
  reactionId: string;
  emoji: string;
  count: number;
  viewerHasReacted: boolean;
};

// ─── Author ──────────────────────────────────────────────────────────────────

export type ArticleAuthorDto = {
  id: string;
  username: string | null;
  name: string | null;
  bio: string | null;
  /** Per-author override bio shown at the bottom of articles. Falls back to `bio` if null. */
  articleBio: string | null;
  avatarUrl: string | null;
  premium: boolean;
  premiumPlus: boolean;
  isOrganization: boolean;
  stewardBadgeEnabled: boolean;
  verifiedStatus: VerifiedStatus;
  orgAffiliations: Array<{ id: string; username: string | null; name: string | null; avatarUrl: string | null }>;
};

export type ArticleAuthorRow = PostAuthorRow & {
  bio: string | null;
  articleBio: string | null;
};

// ─── Article share preview (embedded in feed posts) ──────────────────────────

export type ArticleSharePreviewDto = {
  id: string;
  title: string;
  excerpt: string | null;
  thumbnailUrl: string | null;
  visibility: PostVisibility;
  publishedAt: string | null;
  author: Pick<ArticleAuthorDto, 'id' | 'username' | 'name' | 'avatarUrl' | 'verifiedStatus' | 'premium' | 'premiumPlus'>;
};

// ─── Article comment ─────────────────────────────────────────────────────────

export type ArticleCommentDto = {
  id: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  body: string;
  articleId: string;
  parentId: string | null;
  replyCount: number;
  author: ArticleAuthorDto;
  reactions: ArticleReactionSummaryDto[];
  replies?: ArticleCommentDto[];
  viewerHasReacted?: boolean;
};

// ─── Article ─────────────────────────────────────────────────────────────────

export type ArticleTagDto = {
  /** Normalized slug (lowercase, alphanumeric + hyphens). Used as URL param. */
  tag: string;
  /** Display label as the author typed it (may have uppercase). */
  label: string;
};

export type ArticleDto = {
  id: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  title: string;
  slug: string;
  body: string;
  excerpt: string | null;
  thumbnailUrl: string | null;
  visibility: PostVisibility;
  isDraft: boolean;
  lastSavedAt: string;
  boostCount: number;
  commentCount: number;
  viewCount: number;
  readingTimeMinutes: number;
  author: ArticleAuthorDto;
  reactions: ArticleReactionSummaryDto[];
  tags: ArticleTagDto[];
  viewerHasBoosted?: boolean;
  /** False when the viewer's tier does not grant access to this article (preview-only). */
  viewerCanAccess: boolean;
};

// ─── Prisma row types ─────────────────────────────────────────────────────────

export type ArticleWithAuthor = Article & {
  author: ArticleAuthorRow;
  boosts?: ArticleBoost[];
  reactions?: ArticleReaction[];
  // Queries commonly select only lightweight tag fields via include/select.
  tags?: Array<Pick<ArticleTag, 'tag' | 'label'>>;
};

export type ArticleCommentWithAuthorAndReactions = ArticleComment & {
  author: ArticleAuthorRow;
  reactions?: ArticleCommentReaction[];
  replies?: ArticleCommentWithAuthorAndReactions[];
};

// ─── Prisma include helpers ───────────────────────────────────────────────────

function estimateReadingTimeMinutes(tiptapJson: string): number {
  try {
    const doc = JSON.parse(tiptapJson);
    const texts: string[] = [];
    function walk(node: any) {
      if (!node) return;
      if (node.type === 'text' && node.text) texts.push(node.text);
      if (Array.isArray(node.content)) node.content.forEach(walk);
    }
    walk(doc);
    const wordCount = texts.join(' ').split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(wordCount / 200));
  } catch {
    return 1;
  }
}

export const articleAuthorInclude = {
  id: true,
  username: true,
  name: true,
  bio: true,
  articleBio: true,
  premium: true,
  premiumPlus: true,
  isOrganization: true,
  stewardBadgeEnabled: true,
  verifiedStatus: true,
  avatarKey: true,
  avatarUpdatedAt: true,
  bannedAt: true,
  orgMemberships: {
    include: {
      org: {
        select: {
          id: true,
          username: true,
          name: true,
          avatarKey: true,
          avatarUpdatedAt: true,
        },
      },
    },
  },
} as const;

// ─── Conversion helpers ───────────────────────────────────────────────────────

export function toArticleAuthorDto(author: ArticleAuthorRow, publicAssetBaseUrl: string | null): ArticleAuthorDto {
  return {
    id: author.id,
    username: author.username,
    name: author.name,
    bio: author.bio,
    articleBio: author.articleBio,
    avatarUrl: publicAssetUrl({
      publicBaseUrl: publicAssetBaseUrl,
      key: author.avatarKey ?? null,
      updatedAt: author.avatarUpdatedAt ?? null,
    }),
    premium: author.premium,
    premiumPlus: author.premiumPlus,
    isOrganization: Boolean(author.isOrganization),
    stewardBadgeEnabled: Boolean(author.stewardBadgeEnabled),
    verifiedStatus: author.verifiedStatus,
    orgAffiliations: (author.orgMemberships ?? []).map((m) => ({
      id: m.org.id,
      username: m.org.username,
      name: m.org.name,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: publicAssetBaseUrl,
        key: m.org.avatarKey ?? null,
        updatedAt: m.org.avatarUpdatedAt ?? null,
      }),
    })),
  };
}

export function buildReactionSummaries(
  reactions: ArticleReaction[] | ArticleCommentReaction[],
  viewerUserId?: string | null,
): ArticleReactionSummaryDto[] {
  const map = new Map<string, { emoji: string; count: number; viewerHasReacted: boolean }>();
  for (const r of reactions) {
    const existing = map.get(r.reactionId);
    const viewerHasReacted = viewerUserId ? r.userId === viewerUserId : false;
    if (existing) {
      existing.count += 1;
      if (viewerHasReacted) existing.viewerHasReacted = true;
    } else {
      map.set(r.reactionId, { emoji: r.emoji, count: 1, viewerHasReacted });
    }
  }
  return Array.from(map.entries()).map(([reactionId, val]) => ({
    reactionId,
    emoji: val.emoji,
    count: val.count,
    viewerHasReacted: val.viewerHasReacted,
  }));
}

/** Returns first `previewWords` words + "…" of the excerpt for gated preview (null if excerpt is empty). */
function gatedArticleExcerpt(excerptText: string | null, previewWords = 30): string | null {
  const text = (excerptText ?? '').trim();
  if (!text) return null;
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const slice = words.slice(0, previewWords).join(' ');
  return words.length > previewWords ? slice + '…' : slice;
}

export function toArticleDto(
  article: ArticleWithAuthor,
  publicAssetBaseUrl: string | null,
  opts?: {
    viewerUserId?: string | null;
    viewerHasBoosted?: boolean;
    viewerCanAccess?: boolean;
  },
): ArticleDto {
  const canAccess = opts?.viewerCanAccess !== false;
  const thumbnailUrl = article.thumbnailR2Key
    ? publicAssetUrl({ publicBaseUrl: publicAssetBaseUrl, key: article.thumbnailR2Key })
    : null;

  const reactions = buildReactionSummaries(article.reactions ?? [], opts?.viewerUserId);

  return {
    id: article.id,
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
    publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
    editedAt: article.editedAt ? article.editedAt.toISOString() : null,
    deletedAt: article.deletedAt ? article.deletedAt.toISOString() : null,
    title: article.title,
    slug: article.slug,
    body: canAccess ? article.body : '{}',
    excerpt: canAccess ? (article.excerpt ?? null) : gatedArticleExcerpt(article.excerpt ?? null),
    thumbnailUrl: thumbnailUrl || null,
    visibility: article.visibility,
    isDraft: article.isDraft,
    lastSavedAt: article.lastSavedAt.toISOString(),
    boostCount: article.boostCount,
    commentCount: article.commentCount,
    viewCount: article.viewCount,
    readingTimeMinutes: canAccess ? estimateReadingTimeMinutes(article.body) : 0,
    author: toArticleAuthorDto(article.author, publicAssetBaseUrl),
    reactions,
    tags: (article.tags ?? []).map((t) => ({ tag: t.tag, label: t.label })),
    viewerCanAccess: canAccess,
    ...(typeof opts?.viewerHasBoosted === 'boolean' ? { viewerHasBoosted: opts.viewerHasBoosted } : {}),
  };
}

export function toArticleCommentDto(
  comment: ArticleCommentWithAuthorAndReactions,
  publicAssetBaseUrl: string | null,
  opts?: {
    viewerUserId?: string | null;
  },
): ArticleCommentDto {
  const reactions = buildReactionSummaries(comment.reactions ?? [], opts?.viewerUserId);
  const deleted = Boolean(comment.deletedAt);
  return {
    id: comment.id,
    createdAt: comment.createdAt.toISOString(),
    editedAt: comment.editedAt ? comment.editedAt.toISOString() : null,
    deletedAt: comment.deletedAt ? comment.deletedAt.toISOString() : null,
    body: deleted ? '[deleted]' : comment.body,
    articleId: comment.articleId,
    parentId: comment.parentId ?? null,
    replyCount: comment.replyCount,
    author: toArticleAuthorDto(comment.author, publicAssetBaseUrl),
    reactions,
    replies: comment.replies?.map((r) => toArticleCommentDto(r, publicAssetBaseUrl, opts)),
  };
}

export function toArticleSharePreviewDto(
  article: ArticleWithAuthor,
  publicAssetBaseUrl: string | null,
): ArticleSharePreviewDto {
  const thumbnailUrl = article.thumbnailR2Key
    ? publicAssetUrl({ publicBaseUrl: publicAssetBaseUrl, key: article.thumbnailR2Key })
    : null;
  return {
    id: article.id,
    title: article.title,
    excerpt: article.excerpt ?? null,
    thumbnailUrl: thumbnailUrl || null,
    visibility: article.visibility,
    publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
    author: {
      id: article.author.id,
      username: article.author.username,
      name: article.author.name,
      avatarUrl: publicAssetUrl({
        publicBaseUrl: publicAssetBaseUrl,
        key: article.author.avatarKey ?? null,
        updatedAt: article.author.avatarUpdatedAt ?? null,
      }),
      verifiedStatus: article.author.verifiedStatus,
      premium: article.author.premium,
      premiumPlus: article.author.premiumPlus,
    },
  };
}
