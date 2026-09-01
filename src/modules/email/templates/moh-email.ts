export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Light lodge tokens (mirrors `:root` in menofhunger-www). Used as inline
 * defaults so Outlook and clients that strip `<style>` stay readable.
 * Hex only — many clients drop CSS variables and rgba.
 */
export const EMAIL = {
  page: '#FBFAF7',
  surface: '#F3F2EE',
  /** Off-white — avoid #FFF so Gmail/Apple do not invert the card. */
  elevated: '#F7F4EE',
  border: '#E4DFD4',
  text: '#141210',
  muted: '#5F5A55',
  soft: '#7A746E',
  brass: '#A37422',
  brassLink: '#A37422',
  font: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', Times, serif",
} as const;

/** Dark lodge tokens (mirrors `html.dark`). Applied via prefers-color-scheme. */
export const EMAIL_DARK = {
  page: '#0F1113',
  surface: '#14181C',
  elevated: '#1B2127',
  border: '#2A323A',
  text: '#F4F4F5',
  muted: '#A3AAB4',
  soft: '#7F8792',
  brass: '#A37422',
  brassLink: '#E0C078',
} as const;

export const EMAIL_CLASS = {
  bg: 'moh-bg',
  surface: 'moh-surface',
  elev: 'moh-elev',
  text: 'moh-text',
  muted: 'moh-muted',
  soft: 'moh-soft',
  link: 'moh-link',
  border: 'moh-border',
  rule: 'moh-rule',
} as const;

type EmailColorRule = { selectors: string[]; decls: string };

function emitColorRules(rules: EmailColorRule[], prefix: string): string {
  const out: string[] = [];
  for (const rule of rules) {
    for (const sel of rule.selectors) {
      // Outlook.com does not apply grouped selectors with [data-ogsc].
      // Repeat the prefix on each selector, including on the element itself.
      const targets = prefix ? [`${prefix} ${sel}`, `${prefix}${sel}`] : [sel];
      for (const target of targets) {
        out.push(`${target}{${rule.decls}}`);
      }
    }
  }
  return out.join('');
}

function darkModeColorRules(): EmailColorRule[] {
  const text = `color:${EMAIL_DARK.text}!important;`;
  const muted = `color:${EMAIL_DARK.muted}!important;`;
  const soft = `color:${EMAIL_DARK.soft}!important;`;
  const link = `color:${EMAIL_DARK.brassLink}!important;`;
  return [
    {
      selectors: [`.${EMAIL_CLASS.bg}`],
      decls: `background-color:${EMAIL_DARK.page}!important;${text}`,
    },
    { selectors: [`.${EMAIL_CLASS.surface}`], decls: `background-color:${EMAIL_DARK.surface}!important;` },
    { selectors: [`.${EMAIL_CLASS.elev}`], decls: `background-color:${EMAIL_DARK.elevated}!important;` },
    {
      selectors: [
        `.${EMAIL_CLASS.bg} *`,
        `.${EMAIL_CLASS.surface} *`,
        `.${EMAIL_CLASS.elev} *`,
        `.${EMAIL_CLASS.text}`,
        `.${EMAIL_CLASS.bg} .${EMAIL_CLASS.text}`,
        `.${EMAIL_CLASS.surface} .${EMAIL_CLASS.text}`,
      ],
      decls: text,
    },
    {
      selectors: [`.${EMAIL_CLASS.muted}`, `.${EMAIL_CLASS.bg} .${EMAIL_CLASS.muted}`, `.${EMAIL_CLASS.surface} .${EMAIL_CLASS.muted}`],
      decls: muted,
    },
    {
      selectors: [`.${EMAIL_CLASS.soft}`, `.${EMAIL_CLASS.bg} .${EMAIL_CLASS.soft}`, `.${EMAIL_CLASS.surface} .${EMAIL_CLASS.soft}`],
      decls: soft,
    },
    {
      selectors: [`.${EMAIL_CLASS.link}`, `.${EMAIL_CLASS.bg} .${EMAIL_CLASS.link}`, `.${EMAIL_CLASS.surface} .${EMAIL_CLASS.link}`],
      decls: link,
    },
    { selectors: [`.${EMAIL_CLASS.border}`], decls: `border-color:${EMAIL_DARK.border}!important;` },
    { selectors: [`.${EMAIL_CLASS.rule}`], decls: `border-top-color:${EMAIL_DARK.border}!important;` },
  ];
}

export function emailColorSchemeCss(): string {
  const rules = darkModeColorRules();
  return [
    `:root,html,body{color-scheme:light dark;}`,
    `@media (prefers-color-scheme:dark){${emitColorRules(rules, '')}}`,
    emitColorRules(rules, '[data-ogsc]'),
    emitColorRules(rules, '[data-ogsb]'),
  ].join('');
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

  const semantic =
    (opts.actorTier ?? null) === 'premium' || (opts.postVisibility ?? null) === 'premiumOnly'
      ? { bg: '#F3E6C8', border: EMAIL.brass, text: EMAIL.brass }
      : (opts.actorTier ?? null) === 'verified' || (opts.postVisibility ?? null) === 'verifiedOnly'
        ? { bg: '#E4F0F8', border: '#2B7BB9', text: '#2B7BB9' }
        : (opts.actorTier ?? null) === 'organization'
          ? { bg: EMAIL.elevated, border: EMAIL.border, text: EMAIL.muted }
          : (opts.actorTier ?? null) === 'onlyMe' || (opts.postVisibility ?? null) === 'onlyMe'
            ? { bg: '#EDE8FA', border: '#6B4FD3', text: '#6B4FD3' }
            : null;

  const colors =
    semantic ??
    (tone === 'success'
      ? { bg: '#E6F6EE', border: '#1F9D63', text: '#146C43' }
      : tone === 'warning'
        ? { bg: '#F3E6C8', border: EMAIL.brass, text: EMAIL.brass }
        : tone === 'info'
          ? { bg: '#E4F0F8', border: '#2B7BB9', text: '#2B7BB9' }
          : { bg: EMAIL.elevated, border: EMAIL.border, text: EMAIL.text });

  return `<span style="display:inline-block;padding:3px 8px;border-radius:999px;background:${colors.bg};border:1px solid ${colors.border};font-size:11px;color:${colors.text};white-space:nowrap;">${escapeHtml(
    label,
  )}</span>`;
}

export function renderButton(params: { href: string; label: string; variant?: 'primary' | 'secondary' }): string {
  const variant = params.variant ?? 'primary';
  const href = escapeHtml(params.href);
  const label = escapeHtml(params.label);

  const style =
    variant === 'secondary'
      ? `display:inline-block;padding:10px 14px;border-radius:10px;background:${EMAIL.elevated};color:${EMAIL.text};text-decoration:none;font-weight:700;font-size:13px;border:1px solid ${EMAIL.border};`
      : `display:inline-block;padding:10px 14px;border-radius:10px;background:${EMAIL.brass};color:${EMAIL_DARK.page};text-decoration:none;font-weight:800;font-size:13px;`;

  const cls = variant === 'secondary' ? ` class="${EMAIL_CLASS.elev} ${EMAIL_CLASS.text} ${EMAIL_CLASS.border}"` : '';
  return `<a href="${href}"${cls} style="${style}">${label}</a>`;
}

export function renderCard(innerHtml: string): string {
  return `<div class="${EMAIL_CLASS.elev} ${EMAIL_CLASS.border}" style="margin-top:8px;padding:12px;border:1px solid ${EMAIL.border};background:${EMAIL.elevated};border-radius:12px;">${innerHtml}</div>`;
}

export function emailFooterLink(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" class="${EMAIL_CLASS.soft}" style="color:${EMAIL.soft};text-decoration:underline;">${escapeHtml(label)}</a>`;
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
    `<html lang="en" style="color-scheme:light dark;">`,
    `<head>`,
    `<meta charset="utf-8" />`,
    `<meta name="viewport" content="width=device-width,initial-scale=1" />`,
    `<meta name="color-scheme" content="light dark" />`,
    `<meta name="supported-color-schemes" content="light dark" />`,
    `<meta name="x-apple-disable-message-reformatting" />`,
    `<title>${title}</title>`,
    `<style type="text/css">${emailColorSchemeCss()}</style>`,
    `<link rel="preconnect" href="https://fonts.googleapis.com" />`,
    `<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet" />`,
    `</head>`,
    `<body class="${EMAIL_CLASS.bg}" bgcolor="${EMAIL.page}" style="margin:0;padding:0;background:${EMAIL.page};color:${EMAIL.text};font-family:${EMAIL.font};color-scheme:light dark;">`,
    `<style type="text/css">${emailColorSchemeCss()}</style>`,
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>`,
    `<table role="presentation" class="${EMAIL_CLASS.bg}" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${EMAIL.page}" style="background:${EMAIL.page};padding:24px 0;">`,
    `<tr><td align="center" style="padding:0 12px;">`,
    `<table role="presentation" class="${EMAIL_CLASS.surface} ${EMAIL_CLASS.border}" cellpadding="0" cellspacing="0" border="0" width="600" bgcolor="${EMAIL.surface}" style="width:100%;max-width:600px;background:${EMAIL.surface};border:1px solid ${EMAIL.border};border-radius:14px;overflow:hidden;">`,
    `<tr><td class="${EMAIL_CLASS.bg}" bgcolor="${EMAIL.page}" style="height:4px;background:linear-gradient(90deg,${EMAIL.page} 0%, ${EMAIL.brass} 50%, ${EMAIL.page} 100%);font-size:0;line-height:0;">&nbsp;</td></tr>`,
    `<tr><td style="padding:18px 22px 10px 22px;">`,
    `<div class="${EMAIL_CLASS.muted}" style="font-size:11px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:${EMAIL.muted};">Men of Hunger</div>`,
    `</td></tr>`,
    `<tr><td style="padding:6px 22px 22px 22px;">`,
    params.contentHtml,
    `</td></tr>`,
    `</table>`,
    footer
      ? `<div class="${EMAIL_CLASS.soft}" style="width:100%;max-width:600px;margin:12px auto 0 auto;padding:0 12px;font-size:11px;line-height:1.6;color:${EMAIL.soft};text-align:center;">${footer}</div>`
      : `<div class="${EMAIL_CLASS.soft}" style="width:100%;max-width:600px;margin:12px auto 0 auto;padding:0 12px;font-size:11px;line-height:1.6;color:${EMAIL.soft};text-align:center;">Men of Hunger</div>`,
    `</td></tr></table>`,
    `</body></html>`,
  ].join('');
}
