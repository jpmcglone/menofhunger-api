export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type PillTone = 'neutral' | 'info' | 'warning' | 'success';
type PillActorTier = 'premium' | 'verified' | 'organization' | 'onlyMe';
type PillPostVisibility = 'public' | 'verifiedOnly' | 'premiumOnly' | 'onlyMe';

export function renderPill(
  label: string,
  toneOrOptions: PillTone | { tone?: PillTone; actorTier?: PillActorTier | null; postVisibility?: PillPostVisibility | null } = 'neutral',
): string {
  const opts = typeof toneOrOptions === 'string' ? { tone: toneOrOptions } : toneOrOptions;
  const tone: PillTone = (opts.tone ?? 'neutral') as PillTone;

  // App-aligned semantic accents (approximate, email-safe).
  const semantic =
    (opts.actorTier ?? null) === 'premium' || (opts.postVisibility ?? null) === 'premiumOnly'
      ? { bg: '#FFF7ED', border: '#FDBA74', text: '#C77D1A' }
      : (opts.actorTier ?? null) === 'verified' || (opts.postVisibility ?? null) === 'verifiedOnly'
        ? { bg: '#EFF6FF', border: '#BFDBFE', text: '#2B7BB9' }
        : (opts.actorTier ?? null) === 'organization'
          ? { bg: '#F3F4F6', border: '#D1D5DB', text: '#8A93A3' }
          : (opts.actorTier ?? null) === 'onlyMe' || (opts.postVisibility ?? null) === 'onlyMe'
            ? { bg: '#F5F3FF', border: '#C4B5FD', text: '#6B4FD3' }
            : null;

  const colors =
    semantic ??
    (tone === 'success'
      ? { bg: '#ECFDF5', border: '#A7F3D0', text: '#065F46' }
      : tone === 'warning'
        ? { bg: '#FFFBEB', border: '#FDE68A', text: '#92400E' }
        : tone === 'info'
          ? { bg: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8' }
          : { bg: '#F3F4F6', border: '#E5E7EB', text: '#111827' });

  return `<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${colors.bg};border:1px solid ${colors.border};font-size:12px;color:${colors.text};white-space:nowrap;">${escapeHtml(
    label,
  )}</span>`;
}

export function renderButton(params: { href: string; label: string; variant?: 'primary' | 'secondary' }): string {
  const variant = params.variant ?? 'primary';
  const href = escapeHtml(params.href);
  const label = escapeHtml(params.label);

  const style =
    variant === 'secondary'
      ? 'display:inline-block;padding:11px 14px;border-radius:12px;background:#ffffff;color:#111827;text-decoration:none;font-weight:700;font-size:14px;border:1px solid #e5e7eb;'
      : 'display:inline-block;padding:11px 14px;border-radius:12px;background:#111827;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;';

  return `<a href="${href}" style="${style}">${label}</a>`;
}

export function renderCard(innerHtml: string): string {
  return `<div style="margin-top:12px;padding:14px 14px;border:1px solid #e5e7eb;background:#ffffff;border-radius:14px;">${innerHtml}</div>`;
}

export function renderMohEmail(params: {
  title: string;
  preheader: string;
  contentHtml: string;
  footerHtml?: string | null;
}): string {
  const title = escapeHtml(params.title);
  const preheader = escapeHtml(params.preheader);
  const footer = (params.footerHtml ?? '').trim();

  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8" />`,
    `<meta name="viewport" content="width=device-width,initial-scale=1" />`,
    `<meta name="x-apple-disable-message-reformatting" />`,
    `<title>${title}</title>`,
    `</head>`,
    `<body style="margin:0;padding:0;background:#f6f7f9;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">`,
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f7f9;padding:26px 0;">`,
    `<tr><td align="center" style="padding:0 12px;">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;">`,
    // top accent bar
    `<tr><td style="height:6px;background:linear-gradient(90deg,#111827 0%, #f59e0b 55%, #111827 100%);"></td></tr>`,
    `<tr><td style="padding:18px 22px 10px 22px;">`,
    `<div style="font-size:13px;font-weight:800;letter-spacing:0.10em;text-transform:uppercase;color:#111827;">Men of Hunger</div>`,
    `</td></tr>`,
    `<tr><td style="padding:10px 22px 18px 22px;">`,
    params.contentHtml,
    `</td></tr>`,
    `</table>`,
    footer
      ? `<div style="width:100%;max-width:600px;margin:10px auto 0 auto;padding:0 12px;font-size:11px;line-height:1.6;color:#9ca3af;text-align:center;">${footer}</div>`
      : `<div style="width:100%;max-width:600px;margin:10px auto 0 auto;padding:0 12px;font-size:11px;line-height:1.6;color:#9ca3af;text-align:center;">Men of Hunger</div>`,
    `</td></tr></table>`,
    `</body></html>`,
  ].join('');
}

