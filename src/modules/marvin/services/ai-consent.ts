import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';

export const AI_CONSENT_VERSION = 1;
export async function hasAiConsent(prisma: PrismaService, userId: string): Promise<boolean> {
  const settings = await prisma.marvinUserSettings.findUnique({ where: { userId }, select: { aiConsentAt: true, aiConsentVersion: true } });
  return Boolean(settings?.aiConsentAt && settings.aiConsentVersion === AI_CONSENT_VERSION);
}

export async function requireAiConsent(prisma: PrismaService, userId: string): Promise<void> {
  if (!await hasAiConsent(prisma, userId)) throw new ForbiddenException({
    message: 'Choose whether to share data with OpenAI before using MARV.', error: 'ai_consent_required',
  });
}

