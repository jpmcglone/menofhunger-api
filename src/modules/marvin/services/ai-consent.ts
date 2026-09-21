import type { PrismaService } from '../../prisma/prisma.service';

export const AI_CONSENT_VERSION = 1;

export async function hasAiConsent(prisma: PrismaService, userId: string): Promise<boolean> {
  const settings = await prisma.marvinUserSettings.findUnique({
    where: { userId },
    select: { aiConsentAt: true, aiConsentVersion: true },
  });
  return Boolean(settings?.aiConsentAt && settings.aiConsentVersion === AI_CONSENT_VERSION);
}

/** Marv is on. Using it records current personal-request permission without a client gate. */
export async function requireAiConsent(prisma: PrismaService, userId: string): Promise<void> {
  if (await hasAiConsent(prisma, userId)) return;
  await prisma.marvinUserSettings.upsert({
    where: { userId },
    create: { userId, aiConsentAt: new Date(), aiConsentVersion: AI_CONSENT_VERSION },
    update: { aiConsentAt: new Date(), aiConsentVersion: AI_CONSENT_VERSION },
  });
}
