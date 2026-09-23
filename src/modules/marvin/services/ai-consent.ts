import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import { MARV_ERROR_CODES } from '../marvin.constants';

/** Bumped when the disclosure changes or consent was recorded without a prompt; older grants re-ask. */
export const AI_CONSENT_VERSION = 2;

export async function hasAiConsent(prisma: PrismaService, userId: string): Promise<boolean> {
  const settings = await prisma.marvinUserSettings.findUnique({
    where: { userId },
    select: { aiConsentAt: true, aiConsentVersion: true },
  });
  return Boolean(settings?.aiConsentAt && settings.aiConsentVersion === AI_CONSENT_VERSION);
}

/**
 * App Store 5.1.2(i): personal data reaches OpenAI only after explicit permission.
 * Clients prompt on `ai_consent_required`, record the choice via PATCH /marvin/me/preferences,
 * then retry. Never grant permission implicitly here.
 */
export async function requireAiConsent(prisma: PrismaService, userId: string): Promise<void> {
  if (await hasAiConsent(prisma, userId)) return;
  throw new ForbiddenException({
    message: 'Allow MARV to use OpenAI before sending this.',
    error: MARV_ERROR_CODES.aiConsentRequired,
  });
}
