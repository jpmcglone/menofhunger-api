import { EMAIL, EMAIL_CLASS, escapeHtml, renderButton, renderMohEmail } from './templates/moh-email';

export type SpaceScheduleEmailKind = 'announced' | 'soon' | 'cancelled';

export function buildFollowedSpaceEmail(params: {
  greeting: string;
  hostName: string;
  spaceTitle: string;
  whenLabel: string;
  spaceUrl: string;
  settingsUrl: string;
  kind?: SpaceScheduleEmailKind;
  thumbnailUrl?: string | null;
  videoTitle?: string | null;
}): { subject: string; text: string; html: string } {
  const host = params.hostName.trim() || 'Someone you follow';
  const title = params.spaceTitle.trim() || 'a space';
  const when = params.whenLabel.trim();
  const kind = params.kind ?? 'announced';
  const thumbnailUrl = (params.thumbnailUrl ?? '').trim();
  const videoTitle = distinctVideoTitle(title, params.videoTitle);

  const subject =
    kind === 'cancelled'
      ? `${title} was cancelled`
      : kind === 'soon'
        ? `${title} starts in 30 minutes`
        : when
          ? `${title} · ${when}`
          : `${host} scheduled ${title}`;

  const lead =
    kind === 'cancelled'
      ? `${host} cancelled ${title}.`
      : kind === 'soon'
        ? `${title} starts in about 30 minutes.`
        : `${host} scheduled ${title}.`;

  const whenLine = kind === 'cancelled' || !when ? '' : `Tune in ${when}.`;
  const watchingLine = videoTitle ? `Watching: ${videoTitle}` : '';

  const leadHtml =
    kind === 'cancelled'
      ? `${escapeHtml(host)} cancelled <strong>${escapeHtml(title)}</strong>.`
      : kind === 'soon'
        ? `<strong>${escapeHtml(title)}</strong> starts in about 30 minutes.`
        : `${escapeHtml(host)} scheduled <strong>${escapeHtml(title)}</strong>.`;

  const thumbnailHtml = thumbnailUrl
    ? [
        `<div style="margin-bottom:16px;border-radius:10px;overflow:hidden;">`,
        `<a href="${escapeHtml(params.spaceUrl)}" style="display:block;">`,
        `<img src="${escapeHtml(thumbnailUrl)}" alt="${escapeHtml(videoTitle || title)}" width="556" style="width:100%;display:block;border-radius:10px;" />`,
        `</a>`,
        `</div>`,
      ].join('')
    : '';

  const watchingHtml = watchingLine
    ? `<div class="${EMAIL_CLASS.muted}" style="margin-top:6px;font-size:14px;line-height:1.5;color:${EMAIL.muted};">${escapeHtml(watchingLine)}</div>`
    : '';

  const text = [
    params.greeting,
    '',
    lead,
    ...(whenLine ? [whenLine] : []),
    ...(watchingLine ? [watchingLine] : []),
    '',
    params.spaceUrl,
    '',
    `You're getting this because you follow ${host}.`,
    `Manage email settings: ${params.settingsUrl}`,
  ].join('\n');

  const html = renderMohEmail({
    title: subject,
    preheader: whenLine || lead,
    contentHtml: [
      thumbnailHtml,
      `<div class="${EMAIL_CLASS.text}" style="font-size:16px;line-height:1.6;color:${EMAIL.text};">${escapeHtml(params.greeting)}</div>`,
      `<div class="${EMAIL_CLASS.text}" style="margin-top:14px;font-size:16px;line-height:1.6;color:${EMAIL.text};">${leadHtml}</div>`,
      watchingHtml,
      whenLine
        ? `<div class="${EMAIL_CLASS.text}" style="margin-top:8px;font-size:16px;font-weight:700;color:${EMAIL.text};">${escapeHtml(whenLine)}</div>`
        : '',
      `<div style="margin-top:18px;">${renderButton({
        href: params.spaceUrl,
        label: kind === 'cancelled' ? 'Open spaces' : 'Open the space',
      })}</div>`,
    ].join(''),
    footerHtml: `You're getting this because you follow ${escapeHtml(host)}. <a href="${escapeHtml(params.settingsUrl)}" class="${EMAIL_CLASS.soft}" style="color:${EMAIL.soft};text-decoration:underline;">Manage email settings</a>`,
  });

  return { subject, text, html };
}

function distinctVideoTitle(spaceTitle: string, videoTitle: string | null | undefined): string {
  const playing = (videoTitle ?? '').trim();
  if (!playing) return '';
  return playing.toLowerCase() === spaceTitle.trim().toLowerCase() ? '' : playing;
}
