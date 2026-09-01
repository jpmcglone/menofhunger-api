import { linkifyEmailText, siteOriginFromUrl } from './email-rich-text';
import { EMAIL, EMAIL_CLASS, EMAIL_DARK, escapeHtml, renderButton, renderCard, renderMohEmail, renderPill } from './templates/moh-email';

type TiptapEmailOpts = { siteUrl?: string };

// ─── Tiptap JSON → email-safe HTML ────────────────────────────────────────────

/**
 * Renders the first `maxParagraphs` block-level nodes of a Tiptap document as
 * inline-styled, email-client-safe HTML. Supports the most common marks and
 * nodes that appear in Men of Hunger articles. Unknown nodes are skipped.
 *
 * Returns null when the body is empty / unparseable.
 */
export function renderTiptapPreviewHtml(
  tiptapJsonString: string,
  maxParagraphs = 3,
  opts?: TiptapEmailOpts,
): string | null {
  return renderTiptapDocHtml(tiptapJsonString, maxParagraphs, opts);
}

/** Full-document TipTap → email-safe HTML (no paragraph cap). */
export function renderTiptapEmailHtml(tiptapJsonString: string, opts?: TiptapEmailOpts): string | null {
  return renderTiptapDocHtml(tiptapJsonString, Number.POSITIVE_INFINITY, opts);
}

function renderTiptapDocHtml(tiptapJsonString: string, maxBlocks: number, opts?: TiptapEmailOpts): string | null {
  let doc: any;
  try {
    doc = JSON.parse(tiptapJsonString);
  } catch {
    return null;
  }

  if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return null;

  const blocks: string[] = [];

  for (const node of doc.content) {
    if (blocks.length >= maxBlocks) break;
    const rendered = renderBlock(node, opts);
    if (rendered) blocks.push(rendered);
  }

  return blocks.length > 0 ? blocks.join('') : null;
}

function renderInlineContent(content: any[], opts?: TiptapEmailOpts): string {
  if (!Array.isArray(content)) return '';
  return content.map((node) => renderInlineNode(node, opts)).join('');
}

function renderInlineNode(node: any, opts?: TiptapEmailOpts): string {
  if (!node) return '';

  if (node.type === 'text') {
    const raw = String(node.text ?? '');
    const marks: any[] = node.marks ?? [];
    const hasLink = marks.some((mark) => mark.type === 'link');
    const isCode = marks.some((mark) => mark.type === 'code');
    let text =
      !isCode && !hasLink && opts?.siteUrl
        ? linkifyEmailText(raw, opts.siteUrl)
        : escapeHtml(raw);

    for (const mark of marks) {
      switch (mark.type) {
        case 'bold':
        case 'strong':
          text = `<strong>${text}</strong>`;
          break;
        case 'italic':
        case 'em':
          text = `<em>${text}</em>`;
          break;
        case 'underline':
          text = `<span style="text-decoration:underline;">${text}</span>`;
          break;
        case 'strike':
          text = `<s>${text}</s>`;
          break;
        case 'code':
          text = `<code class="${EMAIL_CLASS.elev} ${EMAIL_CLASS.text}" style="font-family:monospace;background:${EMAIL.elevated};padding:1px 4px;border-radius:3px;font-size:13px;color:${EMAIL.text};">${text}</code>`;
          break;
        case 'link': {
          const href = escapeHtml(mark.attrs?.href ?? '');
          if (href) text = `<a href="${href}" class="${EMAIL_CLASS.link}" style="color:${EMAIL.brassLink};text-decoration:underline;">${text}</a>`;
          break;
        }
        default:
          break;
      }
    }
    return text;
  }

  if (node.type === 'hardBreak') return '<br />';

  // Inline images (rare but possible)
  if (node.type === 'image') {
    const src = escapeHtml(node.attrs?.src ?? '');
    const alt = escapeHtml(node.attrs?.alt ?? '');
    if (!src) return '';
    return `<img src="${src}" alt="${alt}" width="564" style="width:100%;max-width:100%;border-radius:6px;display:block;" />`;
  }

  return '';
}

function renderBlock(node: any, opts?: TiptapEmailOpts): string | null {
  if (!node || !node.type) return null;

  switch (node.type) {
    case 'paragraph': {
      const inner = renderInlineContent(node.content ?? [], opts);
      if (!inner.trim()) return null;
      return `<p class="${EMAIL_CLASS.text}" style="margin:0 0 16px 0;font-size:16px;line-height:1.7;color:${EMAIL.text};">${inner}</p>`;
    }

    case 'heading': {
      const level = node.attrs?.level ?? 2;
      const inner = renderInlineContent(node.content ?? [], opts);
      if (!inner.trim()) return null;
      const styles: Record<number, string> = {
        1: `font-size:24px;font-weight:800;letter-spacing:-0.02em;line-height:1.2;color:${EMAIL.text};margin:0 0 14px 0;`,
        2: `font-size:20px;font-weight:800;letter-spacing:-0.015em;line-height:1.25;color:${EMAIL.text};margin:0 0 12px 0;`,
        3: `font-size:16px;font-weight:700;line-height:1.35;color:${EMAIL.text};margin:0 0 10px 0;`,
      };
      const style = styles[level] ?? styles[3];
      return `<div class="${EMAIL_CLASS.text}" style="${style}">${inner}</div>`;
    }

    case 'bulletList': {
      const items = (node.content ?? [])
        .map((li: any) => {
          const inner = (li.content ?? [])
            .map((child: any) => renderInlineContent(child.content ?? [], opts))
            .join('');
          return inner.trim()
            ? `<li class="${EMAIL_CLASS.text}" style="margin:0 0 6px 0;font-size:16px;line-height:1.7;color:${EMAIL.text};">${inner}</li>`
            : '';
        })
        .filter(Boolean);
      return items.length > 0
        ? `<ul style="margin:0 0 16px 0;padding-left:22px;">${items.join('')}</ul>`
        : null;
    }

    case 'orderedList': {
      const items = (node.content ?? [])
        .map((li: any) => {
          const inner = (li.content ?? [])
            .map((child: any) => renderInlineContent(child.content ?? [], opts))
            .join('');
          return inner.trim()
            ? `<li class="${EMAIL_CLASS.text}" style="margin:0 0 6px 0;font-size:16px;line-height:1.7;color:${EMAIL.text};">${inner}</li>`
            : '';
        })
        .filter(Boolean);
      return items.length > 0
        ? `<ol style="margin:0 0 16px 0;padding-left:22px;">${items.join('')}</ol>`
        : null;
    }

    case 'blockquote': {
      const inner = (node.content ?? [])
        .map((child: any) => renderInlineContent(child.content ?? [], opts))
        .join('<br />');
      return inner.trim()
        ? `<blockquote class="${EMAIL_CLASS.muted}" style="margin:0 0 16px 0;padding:4px 0 4px 14px;border-left:3px solid ${EMAIL.brass};color:${EMAIL.muted};font-family:${EMAIL.serif};font-style:italic;font-size:16px;line-height:1.7;">${inner}</blockquote>`
        : null;
    }

    case 'codeBlock': {
      const inner = renderInlineContent(node.content ?? [], opts);
      return inner.trim()
        ? `<pre class="${EMAIL_CLASS.elev} ${EMAIL_CLASS.border} ${EMAIL_CLASS.text}" style="margin:0 0 16px 0;padding:10px 12px;background:${EMAIL.elevated};border:1px solid ${EMAIL.border};border-radius:8px;font-family:monospace;font-size:13px;line-height:1.6;color:${EMAIL.text};overflow:auto;white-space:pre-wrap;">${inner}</pre>`
        : null;
    }

    case 'image': {
      const src = escapeHtml(node.attrs?.src ?? '');
      const alt = escapeHtml(node.attrs?.alt ?? '');
      if (!src) return null;
      return `<img src="${src}" alt="${alt}" width="564" style="width:100%;max-width:100%;border-radius:8px;margin:0 0 16px 0;display:block;" />`;
    }

    case 'horizontalRule':
      return `<hr class="${EMAIL_CLASS.rule}" style="border:none;border-top:1px solid ${EMAIL.border};margin:20px 0;" />`;

    default:
      return null;
  }
}

// ─── Email builder ─────────────────────────────────────────────────────────────

export interface FollowedArticleEmailParams {
  /** Recipient's display name or username for the greeting. */
  greeting: string;
  /** Author display name (name or username). */
  authorName: string;
  /** Author username (for profile link). */
  authorUsername: string | null;
  /** Author avatar URL (may be null). */
  authorAvatarUrl: string | null;
  /** Author bio shown in the "About the author" block (articleBio preferred, fallback to bio). */
  authorBio: string | null;
  /** Whether the author is verified. */
  authorVerified: boolean;
  /** Whether the author is premium or premium+. */
  authorPremium: boolean;
  /** Full URL to the article page. */
  articleUrl: string;
  /** Article title. */
  articleTitle: string;
  /**
   * Stringified Tiptap JSON body. Used to render the first few paragraphs as a
   * preview. Falls back to plain-text excerpt when null / unparseable.
   */
  articleBodyJson: string | null;
  /**
   * Pre-rendered body preview HTML. When provided, skips Tiptap JSON parsing
   * (avoids redundant work when sending the same article to many recipients).
   */
  articleBodyPreviewHtml?: string | null;
  /** Plain-text excerpt fallback (~200 chars, may be null). */
  articleExcerpt: string | null;
  /** Full URL to the article thumbnail image (may be null). */
  articleThumbnailUrl: string | null;
  /** Article visibility label for the badge. */
  articleVisibility: 'public' | 'verifiedOnly' | 'premiumOnly';
  /** Full URL to the author's profile page. */
  authorProfileUrl: string;
  /** Full URL to notification settings page. */
  settingsUrl: string;
}

function visibilityLabel(visibility: FollowedArticleEmailParams['articleVisibility']): string {
  if (visibility === 'verifiedOnly') return 'Verified';
  if (visibility === 'premiumOnly') return 'Premium';
  return 'Public';
}

export function buildFollowedArticleEmail(p: FollowedArticleEmailParams): {
  subject: string;
  text: string;
  html: string;
} {
  const {
    greeting,
    authorName,
    authorUsername,
    authorAvatarUrl,
    authorBio,
    authorVerified,
    authorPremium,
    articleUrl,
    articleTitle,
    articleBodyJson,
    articleBodyPreviewHtml: preRenderedPreview,
    articleExcerpt,
    articleThumbnailUrl,
    articleVisibility,
    authorProfileUrl,
    settingsUrl,
  } = p;

  const subject = `${authorName} published a new article`;

  // Plain-text version uses the excerpt
  const previewText = articleExcerpt ?? articleTitle;
  const text = [
    greeting,
    '',
    `${authorName} just published a new article:`,
    '',
    articleTitle,
    ...(articleExcerpt ? ['', articleExcerpt] : []),
    '',
    `Read it here: ${articleUrl}`,
    '',
    `──────────`,
    `About the author`,
    authorName,
    ...(authorBio ? [authorBio] : []),
    `${authorProfileUrl}`,
    '',
    `You're receiving this because you follow ${authorName}.`,
    `Manage email notification settings: ${settingsUrl}`,
  ].join('\n');

  // ── Body preview HTML ───────────────────────────────────────────────────────
  // Try to render the first 3 block-level nodes from the Tiptap JSON. Fall back
  // to the plain-text excerpt when the body is empty or unparseable.
  const siteUrl = siteOriginFromUrl(articleUrl) || siteOriginFromUrl(settingsUrl);
  const bodyPreviewHtml = preRenderedPreview
    ?? (articleBodyJson ? renderTiptapPreviewHtml(articleBodyJson, 3, { siteUrl }) : null);

  const previewSection = bodyPreviewHtml
    ? [
        `<div class="${EMAIL_CLASS.rule}" style="margin-top:12px;padding-top:12px;border-top:1px solid ${EMAIL.border};">`,
        bodyPreviewHtml,
        `<div class="${EMAIL_CLASS.elev}" style="position:relative;height:40px;margin-top:-40px;background:linear-gradient(to bottom,rgba(251,250,247,0) 0%,${EMAIL.elevated} 100%);pointer-events:none;"></div>`,
        `</div>`,
      ].join('')
    : articleExcerpt
      ? `<div class="${EMAIL_CLASS.muted}" style="margin-top:10px;font-size:14px;line-height:1.8;color:${EMAIL.muted};">${escapeHtml(articleExcerpt)}</div>`
      : '';

  // ── Avatar helper ───────────────────────────────────────────────────────────
  const size = 44;
  const initial = escapeHtml((authorName || '?')[0].toUpperCase());
  const avatarInner = authorAvatarUrl
    ? `<img src="${escapeHtml(authorAvatarUrl)}" width="${size}" height="${size}" alt="${escapeHtml(authorName)}" style="width:${size}px;height:${size}px;border-radius:50%;display:block;object-fit:cover;" />`
    : `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${EMAIL_DARK.elevated};color:${EMAIL_DARK.text};font-size:${Math.round(size * 0.4)}px;font-weight:700;text-align:center;line-height:${size}px;">${initial}</div>`;
  const avatarHtml = `<a href="${escapeHtml(authorProfileUrl)}" style="display:inline-block;text-decoration:none;flex-shrink:0;">${avatarInner}</a>`;

  // ── Author identity pills ───────────────────────────────────────────────────
  const tierPills: string[] = [];
  if (authorPremium) tierPills.push(renderPill('Premium', { actorTier: 'premium' }));
  else if (authorVerified) tierPills.push(renderPill('Verified', { actorTier: 'verified' }));

  const authorDisplayName = escapeHtml(authorName);
  const authorUsernameHtml = authorUsername
    ? `<span class="${EMAIL_CLASS.muted}" style="font-size:12px;color:${EMAIL.muted};">@${escapeHtml(authorUsername)}</span>`
    : '';

  const authorNameLine = `<a href="${escapeHtml(authorProfileUrl)}" class="${EMAIL_CLASS.text}" style="font-size:15px;font-weight:700;color:${EMAIL.text};text-decoration:none;">${authorDisplayName}</a>`;

  const authorBioHtml = authorBio
    ? `<div class="${EMAIL_CLASS.muted}" style="margin-top:6px;font-size:13px;line-height:1.7;color:${EMAIL.muted};">${escapeHtml(authorBio)}</div>`
    : '';

  const aboutAuthorCard = renderCard(
    [
      `<div style="display:flex;gap:12px;align-items:flex-start;">`,
      avatarHtml,
      `<div style="flex:1;min-width:0;">`,
      `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;">`,
      authorNameLine,
      authorUsernameHtml,
      tierPills.length > 0 ? `<span style="display:inline-flex;gap:4px;">${tierPills.join('')}</span>` : '',
      `</div>`,
      authorBioHtml,
      `</div>`,
      `</div>`,
    ].join(''),
  );

  // ── Thumbnail ───────────────────────────────────────────────────────────────
  const thumbnailHtml = articleThumbnailUrl
    ? `<div style="margin-bottom:14px;border-radius:10px;overflow:hidden;"><a href="${escapeHtml(articleUrl)}" style="display:block;"><img src="${escapeHtml(articleThumbnailUrl)}" alt="${escapeHtml(articleTitle)}" width="564" style="width:100%;display:block;border-radius:10px;" /></a></div>`
    : '';

  const visLabel = visibilityLabel(articleVisibility);
  const visibilityBadge =
    articleVisibility !== 'public'
      ? renderPill(visLabel, { postVisibility: articleVisibility })
      : '';

  const html = renderMohEmail({
    title: articleTitle,
    preheader: `${authorName} published a new article: ${previewText}`,
    contentHtml: [
      // Preface
      `<div class="${EMAIL_CLASS.muted}" style="margin-bottom:16px;font-size:13px;color:${EMAIL.muted};">You're receiving this because you follow <strong class="${EMAIL_CLASS.text}" style="color:${EMAIL.text};">${escapeHtml(authorName)}</strong>.</div>`,
      // Article card
      renderCard(
        [
          thumbnailHtml,
          visibilityBadge ? `<div style="margin-bottom:8px;">${visibilityBadge}</div>` : '',
          `<div class="${EMAIL_CLASS.text}" style="font-size:22px;font-weight:800;letter-spacing:-0.02em;line-height:1.25;color:${EMAIL.text};"><a href="${escapeHtml(articleUrl)}" class="${EMAIL_CLASS.text}" style="color:${EMAIL.text};text-decoration:none;">${escapeHtml(articleTitle)}</a></div>`,
          previewSection,
          `<div style="margin-top:14px;">${renderButton({ href: articleUrl, label: 'Read the full article' })}</div>`,
        ].join(''),
      ),
      // About the author
      `<div class="${EMAIL_CLASS.soft}" style="margin-top:20px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL.soft};margin-bottom:6px;">About the author</div>`,
      aboutAuthorCard,
      `<div class="${EMAIL_CLASS.muted}" style="margin-top:14px;font-size:13px;line-height:1.7;color:${EMAIL.muted};">Manage email notification settings: <a href="${escapeHtml(settingsUrl)}" class="${EMAIL_CLASS.link}" style="color:${EMAIL.brassLink};text-decoration:underline;">Settings → Notifications</a></div>`,
    ].join(''),
    footerHtml: `Manage notifications in <a href="${escapeHtml(settingsUrl)}" class="${EMAIL_CLASS.soft}" style="color:${EMAIL.soft};text-decoration:underline;">Settings → Notifications</a> · Men of Hunger`,
  });

  return { subject, text, html };
}
