import { createHash } from 'crypto';
import type { PostKind, PostMediaKind, PostMediaSource, PostVisibility } from '@prisma/client';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import {
  buildShareText,
  linkBlocker,
  nativeBlocker,
  type NativeLimits,
} from '../../common/crosspost/crosspost-eligibility';
import type { PickaxArticlePayload, PickaxPostPayload } from './pickax-api.client';

/** Public web host. Post permalinks live at /post/:id, articles at /articles/:id. */
export const PICKAX_WEB_BASE = 'https://pickax.com';

export function pickaxPostUrl(remoteId: string): string {
  return `${PICKAX_WEB_BASE}/post/${encodeURIComponent(remoteId)}`;
}

export function pickaxArticleUrl(remoteId: string): string {
  return `${PICKAX_WEB_BASE}/articles/${encodeURIComponent(remoteId)}`;
}

export const PICKAX_POST_MAX_LENGTH = 1000;
export const PICKAX_POST_MAX_ATTACHMENTS = 10;

export const PICKAX_NATIVE_LIMITS: NativeLimits = {
  maxChars: PICKAX_POST_MAX_LENGTH,
  weighted: false,
  maxImages: PICKAX_POST_MAX_ATTACHMENTS,
};

export function contentHash(...parts: Array<string | null | undefined>): string {
  return createHash('sha256').update(parts.map((p) => p ?? '').join('\u0000')).digest('hex');
}

// ─── Posts ───────────────────────────────────────────────────────────────────

export type PickaxPostSource = {
  id: string;
  body: string;
  visibility: PostVisibility;
  kind: PostKind;
  boardOnly: boolean;
  isDraft: boolean;
  deletedAt: Date | null;
  scheduledAt: Date | null;
  parentId: string | null;
  communityGroupId: string | null;
  quotedPostId: string | null;
  repostedPostId: string | null;
  hasPoll: boolean;
  media: Array<{
    kind: PostMediaKind;
    source: PostMediaSource;
    r2Key: string | null;
    alt: string | null;
    deletedAt: Date | null;
    position: number;
  }>;
};

/** Why a full Pickax copy cannot hold this post, or null when it can. */
export function postCrosspostBlocker(post: PickaxPostSource): string | null {
  return linkBlocker(post) ?? nativeBlocker(post, PICKAX_NATIVE_LIMITS);
}

function pickaxAttachments(
  post: PickaxPostSource,
  publicBaseUrl: string | null,
): Array<{ url: string; name?: string }> {
  return post.media
    .filter((m) => !m.deletedAt)
    .sort((a, b) => a.position - b.position)
    .flatMap((m, i) => {
      const url = publicAssetUrl({ publicBaseUrl, key: m.r2Key });
      return url ? [{ url, name: (m.alt ?? '').trim() || `image-${i + 1}` }] : [];
    });
}

/** Full post: the words and photos, with no link back. */
export function buildPickaxPostPayload(
  post: PickaxPostSource,
  ctx: { publicBaseUrl: string | null },
): PickaxPostPayload {
  const attachments = pickaxAttachments(post, ctx.publicBaseUrl);
  return {
    content: post.body.trim(),
    ...(attachments.length ? { attachments } : {}),
  };
}

/** Link: a short post whose text points back at Men of Hunger. */
export function buildPickaxLinkPayload(mohUrl: string): PickaxPostPayload {
  return { content: buildShareText(mohUrl), link: mohUrl };
}

// ─── Articles ────────────────────────────────────────────────────────────────

export type PickaxArticleSource = {
  id: string;
  title: string;
  body: string;
  visibility: PostVisibility;
  isDraft: boolean;
  publishedAt: Date | null;
  deletedAt: Date | null;
  thumbnailR2Key: string | null;
};

export function articleCrosspostBlocker(article: PickaxArticleSource): string | null {
  if (article.deletedAt || article.isDraft || !article.publishedAt) return 'not_published';
  if (article.visibility !== 'public') return 'not_public';
  if (!article.title.trim()) return 'no_title';
  return null;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

type TiptapNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
  content?: TiptapNode[];
};

function renderText(node: TiptapNode): string {
  let out = escapeHtml(node.text ?? '');
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        out = `<strong>${out}</strong>`;
        break;
      case 'italic':
        out = `<em>${out}</em>`;
        break;
      case 'underline':
        out = `<u>${out}</u>`;
        break;
      case 'strike':
        out = `<s>${out}</s>`;
        break;
      case 'code':
        out = `<code>${out}</code>`;
        break;
      case 'link': {
        const href = safeUrl(mark.attrs?.href);
        if (href) out = `<a href="${escapeHtml(href)}">${out}</a>`;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function renderChildren(node: TiptapNode): string {
  return (node.content ?? []).map(renderNode).join('');
}

function renderNode(node: TiptapNode): string {
  switch (node.type) {
    case 'text':
      return renderText(node);
    case 'paragraph':
      return `<p>${renderChildren(node)}</p>`;
    case 'heading': {
      const level = Math.min(3, Math.max(2, Number(node.attrs?.level) || 2));
      return `<h${level}>${renderChildren(node)}</h${level}>`;
    }
    case 'bulletList':
      return `<ul>${renderChildren(node)}</ul>`;
    case 'orderedList':
      return `<ol>${renderChildren(node)}</ol>`;
    case 'listItem':
      return `<li>${renderChildren(node)}</li>`;
    case 'blockquote':
    case 'callout':
      return `<blockquote>${renderChildren(node)}</blockquote>`;
    case 'codeBlock':
      return `<pre><code>${renderChildren(node)}</code></pre>`;
    case 'horizontalRule':
      return '<hr>';
    case 'hardBreak':
      return '<br>';
    case 'image': {
      const src = safeUrl(node.attrs?.src);
      if (!src) return '';
      const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
    }
    case 'youtube': {
      // Embeds do not survive Pickax's sanitizer, so keep the video reachable as a link.
      const src = safeUrl(node.attrs?.src);
      return src ? `<p><a href="${escapeHtml(src)}">${escapeHtml(src)}</a></p>` : '';
    }
    default:
      return renderChildren(node);
  }
}

export function tiptapBodyToHtml(bodyJson: string): string {
  if (!bodyJson || bodyJson === '{}') return '';
  try {
    const doc = JSON.parse(bodyJson) as TiptapNode;
    return renderChildren(doc);
  } catch {
    return '';
  }
}

export function articleFooterHtml(author: { name: string | null; username: string }, siteBaseUrl: string): string {
  const label = (author.name ?? '').trim() || `@${author.username}`;
  const href = `${siteBaseUrl.replace(/\/+$/, '')}/u/${encodeURIComponent(author.username)}`;
  return `<hr><p>By <a href="${escapeHtml(href)}">${escapeHtml(label)}</a> on Men of Hunger</p>`;
}

export function buildPickaxArticlePayload(
  article: PickaxArticleSource,
  ctx: { publicBaseUrl: string | null; author: { name: string | null; username: string }; siteBaseUrl: string },
): PickaxArticlePayload {
  const thumbnail = publicAssetUrl({ publicBaseUrl: ctx.publicBaseUrl, key: article.thumbnailR2Key });
  return {
    title: article.title.trim(),
    content: tiptapBodyToHtml(article.body) + articleFooterHtml(ctx.author, ctx.siteBaseUrl),
    ...(thumbnail ? { thumbnail } : {}),
  };
}
