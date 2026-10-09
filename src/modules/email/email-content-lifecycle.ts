import { EMAIL, EMAIL_CLASS, emailFooterLink, escapeHtml, renderButton, renderMohEmail } from './templates/moh-email';

export type LifecycleEmailKind = 'verified' | 'premium' | 'referralReward' | 'grantExpiring' | 'cancellation' | 'paymentAttention' | 'accountChanged' | 'verificationAction' | 'premiumTip';

export type LifecycleEmailParams = {
  kind: LifecycleEmailKind;
  greeting: string;
  url: string;
  settingsUrl: string;
  billingUrl?: string;
  tier?: 'premium' | 'premiumPlus';
  source?: 'stripe' | 'apple' | 'grant' | 'referral';
  expiresAt?: string | null;
  accessTerms?: 'renews' | 'ends' | 'managed';
  paymentDeadline?: string | null;
  verified?: boolean;
  rewardName?: string | null;
  changedField?: 'email' | 'phone';
  occurredAt?: string;
  tip?: 'schedule' | 'group' | 'marv';
};

function dateLabel(value: string | null | undefined, includeTime = false): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric',
    ...(includeTime ? { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' } as const : {}),
  }).format(date);
}

type Copy = { subject: string; preheader: string; lines: string[]; steps?: string[]; action: string };

function lifecycleCopy(p: LifecycleEmailParams): Copy {
  const tier = p.tier === 'premiumPlus' ? 'Premium+' : 'Premium';
  const end = dateLabel(p.expiresAt);
  const terms = end && p.accessTerms === 'ends' ? `Your access runs through ${end}.`
    : end && p.accessTerms === 'renews' ? `Your next renewal is ${end}.` : '';
  const billing = p.source === 'apple' ? 'Manage your subscription through Apple.'
    : p.source === 'stripe' ? 'Manage your subscription in Billing.' : '';

  switch (p.kind) {
    case 'verified': return {
      subject: 'You’re verified. You’re in.',
      preheader: 'Your first conversation starts here.',
      lines: ['Your identity is verified. You can now post, reply, join groups, and take part in daily check-ins.'],
      steps: ['Introduce yourself. What are you working on?', 'Follow a few men whose conversations interest you.', 'Check in when the daily question opens.'],
      action: 'Write your first post',
    };
    case 'premium': return {
      subject: p.verified ? `You’re verified—and ${tier} is ready.` : `Your ${tier} membership is active.`,
      preheader: p.source === 'referral' ? 'Your invite earned you more room to create and connect.' : 'More room to create, connect, and follow through.',
      lines: [
        ...(p.verified ? ['Your identity is verified. You’re ready to join the conversation.'] : []),
        p.source === 'referral' ? `Your referral reward has unlocked ${tier}.`
          : p.source === 'grant' ? `You’ve been given ${tier} access. Make it yours.`
            : `Welcome to ${tier}. Thanks for supporting Men of Hunger.`,
        'You now have 1,000-character posts, video, group creation, scheduled posts, and Marv with your credit allowance. Connected health data also unlocks sleep and HRV summaries.',
        ...(p.tier === 'premiumPlus' ? ['Premium+ also gives you supporter styling and an avatar glow. Thank you for giving more to the community.'] : []),
        ...[terms, billing].filter(Boolean),
      ],
      steps: ['Schedule a thought for the right moment.', 'Create a private group for men you trust.', 'Ask Marv to help you think something through.'],
      action: 'Explore your membership',
    };
    case 'referralReward': return {
      subject: 'Your free month is ready.',
      preheader: 'A good introduction goes both ways.',
      lines: [
        p.rewardName ? `${p.rewardName} verified their identity. Your invite earned you a month of Premium.`
          : 'An invite brought you here. Getting verified earned you a month of Premium.',
        'Try a scheduled post, start a group, or bring a question to Marv.',
        ...(terms ? [terms] : ['Your reward and access dates are in Billing.']),
        'This reward does not start a paid subscription. Any existing subscription keeps its own billing terms.',
      ], action: 'Use your Premium month',
    };
    case 'grantExpiring': return {
      subject: end ? `Your ${tier} access ends ${end}.` : `Your ${tier} access is ending soon.`,
      preheader: 'Keep what works for you. Your verified membership stays free.',
      lines: [
        end ? `Your complimentary ${tier} access ends on ${end}.` : `Your complimentary ${tier} access is nearing its end.`,
        'Want to keep the extra tools? You can choose a membership in Billing.',
        'Your verified membership, public conversations, and daily check-ins remain free.',
      ], action: 'Review your membership',
    };
    case 'cancellation': return {
      subject: 'Your subscription cancellation is confirmed.',
      preheader: end ? `Your paid access continues through ${end}.` : 'Here’s what happens next.',
      lines: [
        'Your subscription is set to end and will not renew.',
        end ? `Your current subscription access continues through ${end}.` : 'You can see your access-through date in your subscription settings.',
        'Your verified membership stays free. We’re glad you’re part of the community.',
      ], action: 'View subscription',
    };
    case 'paymentAttention': {
      const deadline = dateLabel(p.paymentDeadline);
      return {
        subject: 'Your membership payment needs attention.', preheader: 'Check your payment details to keep your membership current.',
        lines: [
          `There’s a problem with your ${tier} subscription payment.`,
          p.source === 'apple' ? 'Open your Apple subscription settings to review the payment.' : 'Review your payment method in Billing.',
          ...(deadline ? [`Please resolve it by ${deadline} to avoid an interruption to paid access.`] : ['Your billing settings show the current status and any next steps.']),
        ], action: p.source === 'apple' ? 'Open Apple subscriptions' : 'Review payment details',
      };
    }
    case 'accountChanged': return {
      subject: `Your account ${p.changedField === 'phone' ? 'phone number' : 'email address'} changed.`,
      preheader: 'A quick security notice for your Men of Hunger account.',
      lines: [
        `The ${p.changedField === 'phone' ? 'login phone number' : 'email address'} on your account was changed${dateLabel(p.occurredAt, true) ? ` on ${dateLabel(p.occurredAt, true)}` : ''}.`,
        'If you made this change, you’re all set.',
        'If this wasn’t you, contact hello@menofhunger.com so we can help secure your account.',
      ], action: 'Review your account',
    };
    case 'verificationAction': return {
      subject: 'One more step to get verified.', preheader: 'Open your verification request to see what’s needed.',
      lines: ['We reviewed your verification request and need another step before we can approve it.', 'Your verification page has the details and what to do next. If you need a hand, reply to this email.'],
      action: 'Review verification',
    };
    case 'premiumTip': {
      const tip = p.tip ?? 'schedule';
      return tip === 'group' ? {
        subject: 'Make a little room for your people.', preheader: 'Your membership includes private groups.',
        lines: ['A project, a shared goal, or a few men you trust. Give the conversation a place of its own.', 'Create a private group and invite the people you want in it.'], action: 'Create a group',
      } : tip === 'marv' ? {
        subject: 'Bring one good question to Marv.', preheader: 'A place to think something through.',
        lines: ['A decision you’re weighing. A plan you want to sharpen. Start with what’s on your mind.', 'Marv is included with your membership, within your credit allowance.'], action: 'Talk to Marv',
      } : {
        subject: 'A thought worth saving for later.', preheader: 'Try scheduling your next post.',
        lines: ['Write when the thought is clear. Share it when the time is right.', 'Your membership lets you schedule posts on web and iOS. Try it with your next update.'], action: 'Schedule a post',
      };
    }
  }
}

export function buildLifecycleEmail(p: LifecycleEmailParams): { subject: string; text: string; html: string } {
  const c = lifecycleCopy(p);
  const optional = p.kind === 'premiumTip' || p.kind === 'grantExpiring';
  const showBilling = ['premium', 'referralReward', 'grantExpiring', 'cancellation', 'paymentAttention'].includes(p.kind)
    && p.billingUrl && p.billingUrl !== p.url;
  const footer = optional ? `Manage email preferences: ${p.settingsUrl}` : 'Questions? Reply to this email or contact hello@menofhunger.com.';
  const text = [p.greeting, '', ...c.lines, ...(c.steps ? ['', ...c.steps.map(line => `• ${line}`)] : []), '', `${c.action}: ${p.url}`, ...(showBilling ? ['', `Manage membership: ${p.billingUrl}`] : []), '', footer].join('\n');
  const paragraph = (line: string) => `<p class="${EMAIL_CLASS.text}" style="margin:0 0 14px;font-size:16px;line-height:1.65;color:${EMAIL.text};">${escapeHtml(line)}</p>`;
  const html = renderMohEmail({
    title: c.subject, preheader: c.preheader,
    contentHtml: [
      `<h1 class="${EMAIL_CLASS.text}" style="margin:0 0 20px;font-size:26px;line-height:1.2;letter-spacing:-0.02em;color:${EMAIL.text};">${escapeHtml(c.subject)}</h1>`,
      paragraph(p.greeting), ...c.lines.map(paragraph),
      ...(c.steps ? [`<ul class="${EMAIL_CLASS.text}" style="margin:4px 0 20px;padding-left:22px;color:${EMAIL.text};font-size:15px;line-height:1.65;">${c.steps.map(line => `<li style="margin-bottom:8px;">${escapeHtml(line)}</li>`).join('')}</ul>`] : []),
      `<div style="margin-top:22px;">${renderButton({ href: p.url, label: c.action, size: 'large' })}</div>`,
      ...(showBilling ? [`<p style="margin:18px 0 0;font-size:13px;">${emailFooterLink(p.billingUrl!, 'Manage membership')}</p>`] : []),
    ].join(''),
    footerHtml: optional ? emailFooterLink(p.settingsUrl, 'Manage email preferences') : `Questions? Reply or ${emailFooterLink('mailto:hello@menofhunger.com', 'get in touch')}.`,
  });
  return { subject: c.subject, text, html };
}
