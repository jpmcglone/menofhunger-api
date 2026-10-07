import { EMAIL, escapeHtml, renderButton, renderCard, renderMohEmail } from './templates/moh-email';

export type OnboardingStage = 1 | 3 | 7;

export type OnboardingSignals = {
  verified: boolean;
  hasPosted: boolean;
  hasCheckedIn: boolean;
  hasInvited: boolean;
};

export type OnboardingNudge = {
  headline: string;
  lines: string[];
  ctaLabel: string;
  ctaPath: string;
};

/**
 * The single next step for a new member, or null when they have already done it.
 * Nothing here repeats a step the member has completed.
 */
export function pickOnboardingNudge(stage: OnboardingStage, s: OnboardingSignals): OnboardingNudge | null {
  if (!s.verified) {
    return {
      headline: 'Finish verifying to unlock Men of Hunger',
      lines: [
        'Verified men can post, check in, and reply across the lodge.',
        'It takes about a minute, and verifying also earns a free month of Premium when you joined through an invite.',
      ],
      ctaLabel: 'Verify now',
      ctaPath: '/settings/verification',
    };
  }
  if (stage === 1 && !s.hasPosted) {
    return {
      headline: 'Say hello to the lodge',
      lines: ['Your first post is the easiest way to be seen. Tell the men here what you are working on.'],
      ctaLabel: 'Write your first post',
      ctaPath: '/home',
    };
  }
  if (stage === 3 && !s.hasCheckedIn) {
    return {
      headline: 'Start a check-in streak',
      lines: ['One honest answer a day, between 5pm and midnight Eastern. Day two is where it starts to stick.'],
      ctaLabel: 'Answer today’s check-in',
      ctaPath: '/home',
    };
  }
  if (stage === 7 && !s.hasInvited) {
    return {
      headline: 'Bring one man',
      lines: [
        'The lodge is better with men you trust in it.',
        'When a man you invite verifies, you both get a free month of Premium.',
      ],
      ctaLabel: 'Get your invite link',
      ctaPath: '/invite',
    };
  }
  return null;
}

export function buildOnboardingNudgeEmail(p: {
  greeting: string;
  nudge: OnboardingNudge;
  baseUrl: string;
  settingsUrl: string;
}): { subject: string; text: string; html: string } {
  const ctaUrl = `${p.baseUrl}${p.nudge.ctaPath}`;
  const subject = p.nudge.headline;
  const text = [p.greeting, '', ...p.nudge.lines, '', `${p.nudge.ctaLabel}: ${ctaUrl}`].join('\n');
  const html = renderMohEmail({
    title: p.nudge.headline,
    preheader: p.nudge.lines[0] ?? p.nudge.headline,
    contentHtml: [
      `<div style="font-size:20px;font-weight:900;line-height:1.25;margin:0 0 6px 0;color:${EMAIL.text};">${escapeHtml(p.nudge.headline)}</div>`,
      `<div style="margin:0 0 14px 0;font-size:14px;line-height:1.7;color:${EMAIL.muted};">${escapeHtml(p.greeting)}</div>`,
      renderCard(
        [
          ...p.nudge.lines.map(
            (line, i) =>
              `<div style="margin-top:${i === 0 ? '0' : '8px'};font-size:14px;line-height:1.8;color:${EMAIL.text};">${escapeHtml(line)}</div>`,
          ),
          `<div style="margin-top:14px;">${renderButton({ href: ctaUrl, label: p.nudge.ctaLabel })}</div>`,
        ].join(''),
      ),
    ].join(''),
    footerHtml: `Turn these emails off in <a href="${escapeHtml(p.settingsUrl)}" style="color:${EMAIL.soft};text-decoration:underline;">Settings → Notifications</a> · Men of Hunger`,
  });
  return { subject, text, html };
}
