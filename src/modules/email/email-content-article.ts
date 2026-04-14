import { escapeHtml, renderButton, renderCard, renderMohEmail, renderPill } from './templates/moh-email';

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
  /** Short excerpt (~200 chars, may be null). */
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
    articleExcerpt,
    articleThumbnailUrl,
    articleVisibility,
    authorProfileUrl,
    settingsUrl,
  } = p;

  const subject = `${authorName} published a new article`;

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

  // ── Avatar helper (inline since we can't import from cron) ──────────────────
  const size = 44;
  const initial = escapeHtml((authorName || '?')[0].toUpperCase());
  const avatarInner = authorAvatarUrl
    ? `<img src="${escapeHtml(authorAvatarUrl)}" width="${size}" height="${size}" alt="${escapeHtml(authorName)}" style="width:${size}px;height:${size}px;border-radius:50%;display:block;object-fit:cover;" />`
    : `<div style="width:${size}px;height:${size}px;border-radius:50%;background:#111827;color:#ffffff;font-size:${Math.round(size * 0.4)}px;font-weight:700;text-align:center;line-height:${size}px;">${initial}</div>`;
  const avatarHtml = `<a href="${escapeHtml(authorProfileUrl)}" style="display:inline-block;text-decoration:none;flex-shrink:0;">${avatarInner}</a>`;

  // ── Author identity pills ───────────────────────────────────────────────────
  const tierPills: string[] = [];
  if (authorPremium) tierPills.push(renderPill('Premium', { actorTier: 'premium' }));
  else if (authorVerified) tierPills.push(renderPill('Verified', { actorTier: 'verified' }));

  const authorDisplayName = escapeHtml(authorName);
  const authorUsernameHtml = authorUsername
    ? `<span style="font-size:12px;color:#6b7280;">@${escapeHtml(authorUsername)}</span>`
    : '';

  const authorNameLine = `<a href="${escapeHtml(authorProfileUrl)}" style="font-size:15px;font-weight:700;color:#111827;text-decoration:none;">${authorDisplayName}</a>`;

  const authorBioHtml = authorBio
    ? `<div style="margin-top:6px;font-size:13px;line-height:1.7;color:#374151;">${escapeHtml(authorBio)}</div>`
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

  const excerptHtml = articleExcerpt
    ? `<div style="margin-top:8px;font-size:14px;line-height:1.8;color:#374151;">${escapeHtml(articleExcerpt)}</div>`
    : '';

  const html = renderMohEmail({
    title: articleTitle,
    preheader: `${authorName} published a new article: ${articleTitle}`,
    contentHtml: [
      // Preface
      `<div style="margin-bottom:16px;font-size:13px;color:#6b7280;">You're receiving this because you follow <strong style="color:#111827;">${escapeHtml(authorName)}</strong>.</div>`,
      // Article card
      renderCard(
        [
          thumbnailHtml,
          visibilityBadge ? `<div style="margin-bottom:8px;">${visibilityBadge}</div>` : '',
          `<div style="font-size:20px;font-weight:900;line-height:1.3;color:#111827;"><a href="${escapeHtml(articleUrl)}" style="color:#111827;text-decoration:none;">${escapeHtml(articleTitle)}</a></div>`,
          excerptHtml,
          `<div style="margin-top:14px;">${renderButton({ href: articleUrl, label: 'Read the full article' })}</div>`,
        ].join(''),
      ),
      // About the author
      `<div style="margin-top:20px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#9ca3af;margin-bottom:6px;">About the author</div>`,
      aboutAuthorCard,
      // Settings note
      `<div style="margin-top:14px;font-size:13px;line-height:1.7;color:#6b7280;">Manage email notification settings: <a href="${escapeHtml(settingsUrl)}" style="color:#111827;text-decoration:underline;">Settings → Notifications</a></div>`,
    ].join(''),
    footerHtml: `Manage notifications in <a href="${escapeHtml(settingsUrl)}" style="color:#9ca3af;text-decoration:underline;">Settings → Notifications</a> · Men of Hunger`,
  });

  return { subject, text, html };
}
