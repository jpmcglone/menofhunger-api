import { ForbiddenException } from '@nestjs/common';
import { AI_CONSENT_VERSION, requireAiConsent } from './ai-consent';

describe('AI permission', () => {
  it.each([null, { aiConsentAt: null, aiConsentVersion: AI_CONSENT_VERSION }, { aiConsentAt: new Date(), aiConsentVersion: 0 }])(
    'refuses without current permission and never grants it implicitly: %p',
    async (settings) => {
      const upsert = jest.fn(async () => ({}));
      const prisma: any = {
        marvinUserSettings: { findUnique: jest.fn(async () => settings), upsert },
      };
      const result = requireAiConsent(prisma, 'u1');
      await expect(result).rejects.toBeInstanceOf(ForbiddenException);
      await expect(requireAiConsent(prisma, 'u1')).rejects.toMatchObject({
        response: { error: 'ai_consent_required' },
      });
      expect(upsert).not.toHaveBeenCalled();
    },
  );

  it('allows a current permission', async () => {
    const prisma: any = {
      marvinUserSettings: {
        findUnique: jest.fn(async () => ({ aiConsentAt: new Date(), aiConsentVersion: AI_CONSENT_VERSION })),
        upsert: jest.fn(),
      },
    };
    await expect(requireAiConsent(prisma, 'u1')).resolves.toBeUndefined();
  });
});
