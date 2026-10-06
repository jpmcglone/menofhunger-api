import { EMAIL, EMAIL_CLASS, escapeHtml, renderButton, renderMohEmail } from './templates/moh-email';

export type GroupEmailKind = 'invite' | 'approved' | 'mention';

type Rendered = { subject: string; text: string; html: string };

export function buildGroupEmail(params: {
  kind: GroupEmailKind;
  greeting: string;
  groupName: string;
  actorName?: string | null;
  note?: string | null;
  channelLabel?: string | null;
  excerpt?: string | null;
  url: string;
  settingsUrl: string;
}): Rendered {
  const group = params.groupName.trim() || 'a group';
  const actor = (params.actorName ?? '').trim() || 'Someone';
  const note = (params.note ?? '').trim();
  const excerpt = (params.excerpt ?? '').trim();
  const channel = (params.channelLabel ?? '').trim();

  let subject: string;
  let lead: string;
  let leadHtml: string;
  let quote = '';
  let cta: string;
  let reason: string;

  if (params.kind === 'invite') {
    subject = `${actor} invited you to ${group}`;
    lead = `${actor} invited you to join ${group} on Men of Hunger.`;
    leadHtml = `${escapeHtml(actor)} invited you to join <strong>${escapeHtml(group)}</strong> on Men of Hunger.`;
    quote = note;
    cta = 'Join the group';
    reason = 'You received an invitation to a group.';
  } else if (params.kind === 'approved') {
    subject = `You're in: ${group}`;
    lead = `Your request to join ${group} was approved.`;
    leadHtml = `Your request to join <strong>${escapeHtml(group)}</strong> was approved.`;
    cta = 'Open the group';
    reason = 'You asked to join a group.';
  } else {
    const where = channel ? `${group} · #${channel}` : group;
    subject = `${actor} mentioned you in ${where}`;
    lead = `${actor} mentioned you in ${where}.`;
    leadHtml = `${escapeHtml(actor)} mentioned you in <strong>${escapeHtml(where)}</strong>.`;
    quote = excerpt;
    cta = 'Open the conversation';
    reason = 'You were mentioned while you were away.';
  }

  const text = [
    params.greeting,
    '',
    lead,
    ...(quote ? ['', `"${quote}"`] : []),
    '',
    params.url,
    '',
    reason,
    `Manage email settings: ${params.settingsUrl}`,
  ].join('\n');

  const quoteHtml = quote
    ? `<div class="${EMAIL_CLASS.muted}" style="margin-top:12px;padding:10px 12px;border-left:3px solid ${EMAIL.border};font-size:15px;line-height:1.5;color:${EMAIL.muted};">${escapeHtml(quote)}</div>`
    : '';

  const html = renderMohEmail({
    title: subject,
    preheader: lead,
    contentHtml: [
      `<div class="${EMAIL_CLASS.text}" style="font-size:16px;line-height:1.6;color:${EMAIL.text};">${escapeHtml(params.greeting)}</div>`,
      `<div class="${EMAIL_CLASS.text}" style="margin-top:14px;font-size:16px;line-height:1.6;color:${EMAIL.text};">${leadHtml}</div>`,
      quoteHtml,
      `<div style="margin-top:18px;">${renderButton({ href: params.url, label: cta })}</div>`,
    ].join(''),
    footerHtml: `${escapeHtml(reason)} <a href="${escapeHtml(params.settingsUrl)}" class="${EMAIL_CLASS.soft}" style="color:${EMAIL.soft};text-decoration:underline;">Manage email settings</a>`,
  });

  return { subject, text, html };
}
