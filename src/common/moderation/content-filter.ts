import { UnprocessableEntityException } from '@nestjs/common';

/** Prevent high-confidence abusive text before publication. Reports and human review
 * remain necessary: local rules cannot establish that every image or statement is safe.
 * This filter runs locally; it does not disclose content to an AI provider. */
const BLOCKED_PATTERNS = [
  /\b(?:i (?:will|am going to|m going to)|we (?:will|are going to|re going to)) (?:kill|murder|rape) (?:you|him|her|them)\b/,
  /\b(?:child|childrens?|underage|preteen|toddler) (?:porn|pornography|nudes)\b/,
  /\b(?:kill|exterminate|gas) all (?:the )?(?:jews|muslims|christians|blacks|whites|gays|immigrants)\b/,
];

export function assertPublishableText(...texts: Array<string | null | undefined>): void {
  const text = texts.filter(Boolean).join(' ').normalize('NFKC').toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (BLOCKED_PATTERNS.some(pattern => pattern.test(text))) {
    throw new UnprocessableEntityException({
      message: 'This content may violate our community rules. Remove threats or abusive content and try again. Contact hello@menofhunger.com if you think this is a mistake.',
      error: 'content_not_allowed',
    });
  }
}
