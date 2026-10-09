import type { VerifiedStatus } from '@prisma/client';
import { EMAIL, escapeHtml, renderButton, renderCard, renderMohEmail, renderPill } from '../email/templates/moh-email';

export function safeBaseUrl(raw: string | null | undefined): string {
  return ((raw ?? '').trim() || 'https://menofhunger.com').replace(/\/$/, '');
}

function relativeTime(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function truncate(s: string, max: number): string {
  const t = (s ?? '').trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

type UserRow = {
  id: string;
  username: string | null;
  name: string | null;
  email: string | null;
  premium: boolean;
  premiumPlus: boolean;
  verifiedStatus: VerifiedStatus;
  isOrganization: boolean;
  createdAt: Date;
};

function renderTierBadge(user: Pick<UserRow, 'premium' | 'premiumPlus' | 'isOrganization' | 'verifiedStatus'>): string {
  if (user.premiumPlus) return renderPill('Premium+', 'warning');
  if (user.premium) return renderPill('Premium', 'warning');
  if (user.isOrganization) return renderPill('Org', 'neutral');
  if (user.verifiedStatus !== 'none') return renderPill('Verified', 'info');
  return '';
}

function renderNewUserRow(user: UserRow, now: Date, baseUrl: string): string {
  const displayName = user.name || user.username || '(no name)';
  const profileUrl = user.username ? `${baseUrl}/u/${encodeURIComponent(user.username)}` : '';
  const timeAgo = relativeTime(user.createdAt, now);
  const badge = renderTierBadge(user);

  const nameHtml = profileUrl
    ? `<a href="${escapeHtml(profileUrl)}" style="color:${EMAIL.text};text-decoration:none;font-weight:600;font-size:13px;">${escapeHtml(displayName)}</a>`
    : `<span style="font-weight:600;font-size:13px;">${escapeHtml(displayName)}</span>`;

  const handleHtml = user.username
    ? `<span style="font-size:12px;color:${EMAIL.muted};margin-left:4px;">@${escapeHtml(user.username)}</span>`
    : '';

  return `
<div style="padding:7px 0;border-bottom:1px solid ${EMAIL.border};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
    <td style="vertical-align:middle;">${nameHtml}${handleHtml}${badge ? `<span style="margin-left:6px;">${badge}</span>` : ''}</td>
    <td style="vertical-align:middle;text-align:right;white-space:nowrap;font-size:11px;color:${EMAIL.soft};">${escapeHtml(timeAgo)}</td>
  </tr></table>
</div>`.trim();
}

function renderStatRow(
  label: string,
  value: string | number,
  opts?: { href?: string; color?: string; dimZero?: boolean },
): string {
  const isZero = Number(value) === 0;
  const effectiveColor = opts?.color ?? (opts?.dimZero && isZero ? EMAIL.soft : EMAIL.text);

  const valueHtml = opts?.href
    ? `<a href="${escapeHtml(opts.href)}" style="font-size:14px;font-weight:700;color:${effectiveColor};text-decoration:none;">${escapeHtml(String(value))} →</a>`
    : `<span style="font-size:14px;font-weight:700;color:${effectiveColor};">${escapeHtml(String(value))}</span>`;

  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-bottom:1px solid #f9fafb;"><tr>
  <td style="padding:5px 0;font-size:13px;color:${EMAIL.muted};">${escapeHtml(label)}</td>
  <td style="padding:5px 0;text-align:right;">${valueHtml}</td>
</tr></table>`.trim();
}

function sectionTitle(title: string, badge?: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:10px;"><tr>
  <td style="font-size:13px;font-weight:700;color:${EMAIL.text};">${escapeHtml(title)}</td>
  ${badge ? `<td style="text-align:right;">${badge}</td>` : ''}
</tr></table>`;
}

// ─── Cron ─────────────────────────────────────────────────────────────────────

export function buildHtml(params: {
  dateLabel: string;
  now: Date;
  baseUrl: string;
  newUsers: UserRow[];
  totalNewUserCount: number;
  totalUserCount: number;
  newFeedbackCount: number;
  newReportCount: number;
  newPostCount: number;
  newReplyCount: number;
  usersWhoPostedCount: number;
  newArticleCount: number;
  newBoardThreadCount: number;
  newBoardCommentCount: number;
  activeUserCount: number;
  wauCount: number;
  bannedUserCount: number;
  pendingReportCount: number;
  unreviewedFeedbackCount: number;
  pendingVerificationCount: number;
  activePremiumCount: number;
  activePremiumPlusCount: number;
  pendingCancellationCount: number;
  newSubscriberRows: Array<{
    id: string;
    username: string | null;
    name: string | null;
    premium: boolean;
    premiumPlus: boolean;
    verifiedStatus: VerifiedStatus;
    isOrganization: boolean;
    stripeSubscriptionPriceId: string | null;
  }>;
  topPost: {
    id: string;
    body: string;
    boostCount: number;
    commentCount: number;
    viewerCount: number;
    totalViewCount: number;
    visibility: string;
    username: string | null;
    name: string | null;
  } | null;
  topArticles: Array<{
    id: string;
    title: string;
    excerpt: string | null;
    boostCount: number;
    commentCount: number;
    viewCount: number;
    totalViewCount: number;
    username: string | null;
  }>;
}): string {
  const {
    dateLabel, now, baseUrl,
    newUsers, totalNewUserCount, totalUserCount,
    newFeedbackCount, newReportCount, newPostCount, newReplyCount, usersWhoPostedCount, newArticleCount,
    newBoardThreadCount, newBoardCommentCount,
    activeUserCount, wauCount, bannedUserCount,
    pendingReportCount, unreviewedFeedbackCount, pendingVerificationCount,
    activePremiumCount, activePremiumPlusCount, pendingCancellationCount,
    newSubscriberRows, topPost, topArticles,
  } = params;

  const sections: string[] = [];

  // ── Page header ──
  sections.push(
    `<h2 style="margin:0 0 4px 0;font-size:20px;font-weight:800;color:${EMAIL.text};">Admin Daily Digest</h2>` +
    `<p style="margin:0 0 18px 0;font-size:13px;color:${EMAIL.muted};">${escapeHtml(dateLabel)}</p>`,
  );

  // ── New Members ──
  {
    const pill = totalNewUserCount > 0
      ? renderPill(String(totalNewUserCount), 'info')
      : renderPill('None', 'neutral');

    let body = '';
    if (totalNewUserCount === 0) {
      body = `<p style="margin:0;font-size:13px;color:${EMAIL.soft};">No new members yesterday.</p>`;
    } else {
      body = newUsers.map((u) => renderNewUserRow(u, now, baseUrl)).join('');
      if (totalNewUserCount > newUsers.length) {
        body += `<p style="margin:8px 0 0 0;font-size:12px;color:${EMAIL.soft};">…and ${totalNewUserCount - newUsers.length} more</p>`;
      }
      body += `<div style="margin-top:12px;">${renderButton({ href: `${baseUrl}/admin/users`, label: 'View All Users →', variant: 'secondary' })}</div>`;
    }
    body += `<div style="margin-top:10px;padding-top:10px;border-top:1px solid ${EMAIL.border};">${renderStatRow('Total members (all-time)', totalUserCount, { color: EMAIL.muted })}</div>`;

    sections.push(renderCard(sectionTitle('New Members', pill) + body));
  }

  // ── Yesterday's Activity ──
  {
    let body = '';
    body += renderStatRow('New posts published', newPostCount);
    body += renderStatRow('Users who posted', usersWhoPostedCount, { dimZero: true });
    body += renderStatRow('New replies / comments', newReplyCount, { dimZero: true });
    body += renderStatRow('New articles published', newArticleCount);
    body += renderStatRow('New Board posts', newBoardThreadCount, { dimZero: true, href: `${baseUrl}/b?sort=new` });
    body += renderStatRow('New Board comments', newBoardCommentCount, { dimZero: true });
    body += renderStatRow('Active users (DAU)', activeUserCount);
    body += renderStatRow('Active users (7-day WAU)', wauCount, { color: EMAIL.muted });
    if (bannedUserCount > 0) {
      body += renderStatRow('Users banned', bannedUserCount, { color: '#dc2626' });
    }
    sections.push(renderCard(sectionTitle("Yesterday's Activity") + body));
  }

  // ── Top Post of the Day ──
  if (topPost) {
    const postUrl = `${baseUrl}/p/${topPost.id}`;
    const authorName = topPost.name || topPost.username || 'Unknown';
    const authorHandle = topPost.username ? `@${topPost.username}` : '';
    const snippet = truncate(topPost.body, 220);

    const visibilityPill =
      topPost.visibility === 'verifiedOnly' ? renderPill('Verified only', 'info')
      : topPost.visibility === 'premiumOnly' ? renderPill('Premium only', 'warning')
      : '';

    const body =
      `<p style="margin:0 0 6px 0;font-size:12px;color:${EMAIL.muted};">` +
      `${escapeHtml(authorName)}${authorHandle ? ` <span style="color:${EMAIL.soft};">${escapeHtml(authorHandle)}</span>` : ''}` +
      `${visibilityPill ? ` ${visibilityPill}` : ''}` +
      `</p>` +
      `<p style="margin:0 0 10px 0;font-size:13px;color:${EMAIL.muted};line-height:1.5;font-style:italic;">"${escapeHtml(snippet)}"</p>` +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;"><tr>` +
      `<td style="padding-right:14px;font-size:12px;color:${EMAIL.muted};">🔁 ${topPost.boostCount} boosts</td>` +
      `<td style="padding-right:14px;font-size:12px;color:${EMAIL.muted};">💬 ${topPost.commentCount} replies</td>` +
      `<td style="padding-right:14px;font-size:12px;color:${EMAIL.muted};">👤 ${topPost.viewerCount} people</td>` +
      `<td style="font-size:12px;color:${EMAIL.muted};">👁 ${Math.max(topPost.viewerCount, topPost.totalViewCount)} views</td>` +
      `</tr></table>` +
      renderButton({ href: postUrl, label: 'View Post →', variant: 'secondary' });

    sections.push(renderCard(sectionTitle('Top Post of the Day') + body));
  }

  // ── Top Articles of the Day ──
  if (topArticles.length > 0) {
    const body = [
      ...topArticles.map((article, idx) => {
        const articleUrl = `${baseUrl}/a/${article.id}`;
        const authorHandle = article.username ? `@${article.username}` : '@unknown';
        return [
          `<div style="${idx > 0 ? `margin-top:10px;padding-top:10px;border-top:1px solid ${EMAIL.border};` : ''}">`,
          `<a href="${escapeHtml(articleUrl)}" style="font-size:14px;line-height:1.6;color:${EMAIL.text};text-decoration:none;font-weight:700;">${escapeHtml(truncate(article.title || 'Untitled article', 140))}</a>`,
          `<div style="margin-top:4px;font-size:12px;color:${EMAIL.muted};">${escapeHtml(authorHandle)} · 👤 ${article.viewCount} · 👁 ${Math.max(article.viewCount, article.totalViewCount)} · 🔁 ${article.boostCount} · 💬 ${article.commentCount}</div>`,
          article.excerpt
            ? `<div style="margin-top:4px;font-size:12px;line-height:1.6;color:${EMAIL.muted};">${escapeHtml(truncate(article.excerpt, 150))}</div>`
            : '',
          `</div>`,
        ].join('');
      }),
    ].join('');
    sections.push(renderCard(sectionTitle('Top Articles of the Day') + body));
  }

  // ── Revenue & Subscriptions ──
  {
    const totalActive = activePremiumCount + activePremiumPlusCount;
    const subBadge = totalActive > 0
      ? renderPill(`${totalActive} active`, 'success')
      : renderPill('None', 'neutral');

    let body = '';
    body += renderStatRow('Active Premium subscribers', activePremiumCount, { dimZero: true });
    body += renderStatRow('Active Premium+ subscribers', activePremiumPlusCount, { dimZero: true });
    body += renderStatRow('New subscribers yesterday', newSubscriberRows.length, {
      color: newSubscriberRows.length > 0 ? '#059669' : undefined,
      dimZero: true,
    });
    if (pendingCancellationCount > 0) {
      body += renderStatRow('Cancelling at period end', pendingCancellationCount, { color: '#d97706' });
    }

    // Mini list of new subscribers
    if (newSubscriberRows.length > 0) {
      body += `<div style="margin-top:10px;padding-top:10px;border-top:1px solid ${EMAIL.border};">`;
      body += `<div style="font-size:11px;font-weight:600;color:${EMAIL.muted};margin-bottom:6px;text-transform:uppercase;letter-spacing:0.06em;">New yesterday</div>`;
      for (const sub of newSubscriberRows) {
        const displayName = sub.name || sub.username || '(no name)';
        const handle = sub.username ? ` @${sub.username}` : '';
        const badge = renderTierBadge(sub);
        body += `<div style="font-size:12px;color:${EMAIL.muted};padding:3px 0;">${escapeHtml(displayName)}${escapeHtml(handle)}${badge ? ` ${badge}` : ''}</div>`;
      }
      body += `</div>`;
    }

    sections.push(renderCard(sectionTitle('Revenue & Subscriptions', subBadge) + body));
  }

  // ── New Feedbacks ──
  {
    const pill = newFeedbackCount > 0
      ? renderPill(String(newFeedbackCount), 'warning')
      : renderPill('None', 'neutral');

    let body = '';
    if (newFeedbackCount === 0) {
      body = `<p style="margin:0;font-size:13px;color:${EMAIL.soft};">No new feedback submissions yesterday.</p>`;
    } else {
      body =
        `<p style="margin:0 0 12px 0;font-size:13px;color:${EMAIL.muted};">${plural(newFeedbackCount, 'new submission')} received.</p>` +
        renderButton({ href: `${baseUrl}/admin/feedback`, label: 'Review Feedbacks →', variant: 'secondary' });
    }

    sections.push(renderCard(sectionTitle('New Feedbacks', pill) + body));
  }

  // ── New Reports ──
  {
    const pill = newReportCount > 0
      ? renderPill(String(newReportCount), 'warning')
      : renderPill('None', 'neutral');

    let body = '';
    if (newReportCount === 0) {
      body = `<p style="margin:0;font-size:13px;color:${EMAIL.soft};">No new reports submitted yesterday.</p>`;
    } else {
      body =
        `<p style="margin:0 0 12px 0;font-size:13px;color:${EMAIL.muted};">${plural(newReportCount, 'new report')} submitted.</p>` +
        renderButton({ href: `${baseUrl}/admin/reports`, label: 'Review Reports →', variant: 'secondary' });
    }

    sections.push(renderCard(sectionTitle('New Reports', pill) + body));
  }

  // ── Open Backlog (only if any) ──
  const hasBacklog = pendingReportCount > 0 || unreviewedFeedbackCount > 0 || pendingVerificationCount > 0;
  if (hasBacklog) {
    let body = '';
    if (pendingReportCount > 0) {
      body += renderStatRow('Pending reports (total)', pendingReportCount, {
        href: `${baseUrl}/admin/reports`,
        color: '#dc2626',
      });
    }
    if (unreviewedFeedbackCount > 0) {
      body += renderStatRow('Unreviewed feedbacks (total)', unreviewedFeedbackCount, {
        href: `${baseUrl}/admin/feedback`,
        color: '#d97706',
      });
    }
    if (pendingVerificationCount > 0) {
      body += renderStatRow('Pending verifications (total)', pendingVerificationCount, {
        href: `${baseUrl}/admin/verification`,
        color: '#2563eb',
      });
    }
    sections.push(renderCard(sectionTitle('Open Backlog', renderPill('Needs attention', 'warning')) + body));
  }

  // ── Preheader ──
  const preheaderParts: string[] = [];
  if (totalNewUserCount > 0) preheaderParts.push(plural(totalNewUserCount, 'new member'));
  if (newSubscriberRows.length > 0) preheaderParts.push(plural(newSubscriberRows.length, 'new subscriber'));
  if (newReportCount > 0) preheaderParts.push(plural(newReportCount, 'new report'));
  if (newFeedbackCount > 0) preheaderParts.push(plural(newFeedbackCount, 'new feedback'));
  if (newPostCount > 0) preheaderParts.push(plural(newPostCount, 'new post'));
  if (newArticleCount > 0) preheaderParts.push(plural(newArticleCount, 'new article'));
  if (newBoardThreadCount > 0) preheaderParts.push(plural(newBoardThreadCount, 'new Board post'));
  const preheader = preheaderParts.length > 0 ? preheaderParts.join(' · ') : 'Daily admin summary';

  return renderMohEmail({
    title: 'Admin Digest',
    preheader,
    contentHtml: sections.join(''),
    footerHtml: 'Men of Hunger — Admin',
  });
}

export function buildText(params: {
  dateLabel: string;
  totalNewUserCount: number;
  totalUserCount: number;
  newFeedbackCount: number;
  newReportCount: number;
  newPostCount: number;
  newReplyCount: number;
  usersWhoPostedCount: number;
  newArticleCount: number;
  newBoardThreadCount: number;
  newBoardCommentCount: number;
  activeUserCount: number;
  wauCount: number;
  bannedUserCount: number;
  pendingReportCount: number;
  unreviewedFeedbackCount: number;
  pendingVerificationCount: number;
  activePremiumCount: number;
  activePremiumPlusCount: number;
  pendingCancellationCount: number;
  newSubscriberCount: number;
  topPost: { id: string; body: string; username: string | null; boostCount: number; commentCount: number; viewerCount: number; totalViewCount: number } | null;
  topArticles: Array<{ id: string; title: string; username: string | null; boostCount: number; commentCount: number; viewCount: number; totalViewCount: number }>;
  baseUrl: string;
}): string {
  const {
    dateLabel, totalNewUserCount, totalUserCount, newFeedbackCount, newReportCount,
    newPostCount, newReplyCount, usersWhoPostedCount, newArticleCount,
    newBoardThreadCount, newBoardCommentCount,
    activeUserCount, wauCount, bannedUserCount,
    pendingReportCount, unreviewedFeedbackCount, pendingVerificationCount,
    activePremiumCount, activePremiumPlusCount, pendingCancellationCount,
    newSubscriberCount, topPost, topArticles, baseUrl,
  } = params;

  const lines: string[] = [
    `Admin Daily Digest — ${dateLabel}`,
    '',
    '── Yesterday ──────────────────────',
    `New members:      ${totalNewUserCount}  (${totalUserCount} total)`,
    `New posts:        ${newPostCount}`,
    `Users who posted: ${usersWhoPostedCount}`,
    `New replies:      ${newReplyCount}`,
    `New articles:     ${newArticleCount}`,
    `Board posts:      ${newBoardThreadCount}`,
    `Board comments:   ${newBoardCommentCount}`,
    `Active users DAU: ${activeUserCount}`,
    `Active users WAU: ${wauCount}`,
  ];

  if (bannedUserCount > 0) lines.push(`Users banned:     ${bannedUserCount}`);

  lines.push('');
  lines.push('── Revenue & Subscriptions ────────');
  lines.push(`Active Premium:    ${activePremiumCount}`);
  lines.push(`Active Premium+:   ${activePremiumPlusCount}`);
  lines.push(`New subscribers:   ${newSubscriberCount}`);
  if (pendingCancellationCount > 0) lines.push(`Cancelling:        ${pendingCancellationCount}`);

  if (topPost) {
    lines.push('');
    lines.push('── Top Post of the Day ────────────');
    if (topPost.username) lines.push(`@${topPost.username}`);
    lines.push(truncate(topPost.body, 200));
    lines.push(`Boosts: ${topPost.boostCount}  Replies: ${topPost.commentCount}  People: ${topPost.viewerCount}  Views: ${Math.max(topPost.viewerCount, topPost.totalViewCount)}`);
    lines.push(`${baseUrl}/p/${topPost.id}`);
  }
  if (topArticles.length > 0) {
    lines.push('');
    lines.push('── Top Articles of the Day ─────────');
    for (const [idx, article] of topArticles.entries()) {
      const handle = article.username ? `@${article.username}` : '@unknown';
      lines.push(`${idx + 1}. ${truncate(article.title, 140)} (${handle})`);
      lines.push(`   👤 ${article.viewCount}  👁 ${Math.max(article.viewCount, article.totalViewCount)}  🔁 ${article.boostCount}  💬 ${article.commentCount}`);
      lines.push(`   ${baseUrl}/a/${article.id}`);
    }
  }

  lines.push('');
  lines.push('── New Submissions ─────────────────');
  lines.push(`Feedbacks:  ${newFeedbackCount}  ${baseUrl}/admin/feedback`);
  lines.push(`Reports:    ${newReportCount}  ${baseUrl}/admin/reports`);

  if (pendingReportCount > 0 || unreviewedFeedbackCount > 0 || pendingVerificationCount > 0) {
    lines.push('');
    lines.push('── Open Backlog ─────────────────────');
    if (pendingReportCount > 0) lines.push(`Pending reports:        ${pendingReportCount}  ${baseUrl}/admin/reports`);
    if (unreviewedFeedbackCount > 0) lines.push(`Unreviewed feedbacks:   ${unreviewedFeedbackCount}  ${baseUrl}/admin/feedback`);
    if (pendingVerificationCount > 0) lines.push(`Pending verifications:  ${pendingVerificationCount}  ${baseUrl}/admin/verification`);
  }

  lines.push('', 'Men of Hunger — Admin');
  return lines.join('\n');
}
