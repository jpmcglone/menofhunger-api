import { escapeHtml, renderButton, renderCard, renderMohEmail, renderPill } from './templates/moh-email';

export type MissingProfileField = 'avatar' | 'bio' | 'banner';

export interface ProfileReminderEmailParams {
  greeting: string;
  missingAvatar: boolean;
  missingBio: boolean;
  missingBanner: boolean;
  settingsUrl: string;
  checkpoint: '24h' | '7d';
}

export function getMissingProfileFields(params: {
  avatarKey: string | null;
  bio: string | null;
  bannerKey: string | null;
}): MissingProfileField[] {
  const missingFields: MissingProfileField[] = [];
  if (!params.avatarKey) missingFields.push('avatar');
  if (!params.bio || params.bio.trim() === '') missingFields.push('bio');
  if (!params.bannerKey) missingFields.push('banner');
  return missingFields;
}

export function describeMissingProfileFields(fields: MissingProfileField[]): string {
  const labels = fields.map((field) => (field === 'avatar' ? 'photo' : field));
  return labels.length > 0 ? labels.join(', ') : '—';
}

function profileReminderSubject(params: {
  checkpoint: '24h' | '7d';
  missingAvatar: boolean;
  missingBio: boolean;
}): string {
  if (params.missingAvatar && params.missingBio) {
    return params.checkpoint === '7d' ? 'Your profile is still incomplete' : 'Finish setting up your profile';
  }
  if (params.missingAvatar) return params.checkpoint === '7d' ? 'Still need a profile photo' : 'Add a profile photo';
  return params.checkpoint === '7d' ? 'Still need a short bio' : 'Add a short bio';
}

function profileReminderIntro(checkpoint: '24h' | '7d'): string {
  return checkpoint === '7d'
    ? `A quick reminder: your profile is still missing a couple of basics.`
    : `Your account is set up, but your profile is still missing a couple of basics.`;
}

function profileReminderCopy(params: {
  checkpoint: '24h' | '7d';
  missingAvatar: boolean;
  missingBio: boolean;
  missingBanner: boolean;
}): { headline: string; lines: string[] } {
  const { checkpoint, missingAvatar, missingBio, missingBanner } = params;

  if (missingAvatar && missingBio) {
    return {
      headline: checkpoint === '7d' ? 'Your profile is still incomplete' : 'Your profile is still empty',
      lines: [
        profileReminderIntro(checkpoint),
        `Add a photo and a short bio so people can recognize you and get a sense of who you are.`,
        ...(missingBanner ? [`If you want, you can also add a banner later.`] : []),
      ],
    };
  }

  if (missingAvatar) {
    return {
      headline: checkpoint === '7d' ? 'Still missing a profile photo' : 'Add a profile photo',
      lines: [
        profileReminderIntro(checkpoint),
        `A photo makes it much easier for people to recognize you in conversations and on the feed.`,
        ...(missingBanner ? [`You can also add a banner later, but the photo matters more.`] : []),
      ],
    };
  }

  return {
    headline: checkpoint === '7d' ? 'Still missing a short bio' : 'Add a short bio',
    lines: [
      profileReminderIntro(checkpoint),
      `A short sentence or two helps people understand who you are and what you care about.`,
      ...(missingBanner ? [`You can also add a banner later if you want to personalize your profile more.`] : []),
    ],
  };
}

export function buildProfileReminderEmail(p: ProfileReminderEmailParams): { subject: string; text: string; html: string } {
  const { greeting, missingAvatar, missingBio, missingBanner, settingsUrl, checkpoint } = p;
  const subject = profileReminderSubject({ checkpoint, missingAvatar, missingBio });
  const { headline, lines } = profileReminderCopy({ checkpoint, missingAvatar, missingBio, missingBanner });
  const missingSummary = `Missing: ${describeMissingProfileFields(
    [
      missingAvatar ? 'avatar' : null,
      missingBio ? 'bio' : null,
      missingBanner ? 'banner' : null,
    ].filter(Boolean) as MissingProfileField[],
  )}.`;

  const text = [
    greeting,
    '',
    ...lines,
    ...(missingSummary ? ['', missingSummary] : []),
    '',
    `Update your profile: ${settingsUrl}`,
  ].join('\n');

  const html = renderMohEmail({
    title: headline,
    preheader: lines[0] ?? headline,
    contentHtml: [
      `<div style="font-size:20px;font-weight:900;line-height:1.25;margin:0 0 6px 0;color:#111827;">${escapeHtml(headline)}</div>`,
      `<div style="margin:0 0 14px 0;font-size:14px;line-height:1.7;color:#374151;">${escapeHtml(greeting)}</div>`,
      renderCard(
        [
          `<div style="margin-bottom:10px;">${renderPill(checkpoint === '7d' ? 'Reminder' : 'Profile setup', 'info')}</div>`,
          ...lines.map((line, index) => {
            const color = index === 0 ? '#111827' : index === lines.length - 1 && missingBanner ? '#6b7280' : '#374151';
            const size = index === lines.length - 1 && missingBanner ? '13px' : '14px';
            return `<div style="margin-top:${index === 0 ? '0' : '8px'};font-size:${size};line-height:1.8;color:${color};">${escapeHtml(
              line,
            )}</div>`;
          }),
          missingSummary
            ? `<div style="margin-top:10px;font-size:12px;line-height:1.7;color:#6b7280;">${escapeHtml(missingSummary)}</div>`
            : ``,
          `<div style="margin-top:14px;">${renderButton({ href: settingsUrl, label: 'Update profile' })}</div>`,
        ].join(''),
      ),
      `<div style="margin-top:14px;font-size:13px;line-height:1.7;color:#6b7280;">You can update your profile any time in Settings → Account.</div>`,
    ].join(''),
    footerHtml: `Men of Hunger`,
  });

  return { subject, text, html };
}
