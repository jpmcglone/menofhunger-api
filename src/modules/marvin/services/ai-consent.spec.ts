import { requireAiConsent } from './ai-consent';

describe('AI permission', () => {
  it.each([null, { aiConsentAt: null, aiConsentVersion: 1 }, { aiConsentAt: new Date(), aiConsentVersion: 0 }])('fails closed without current permission: %p', async (settings) => {
    const prisma: any = { marvinUserSettings: { findUnique: jest.fn(async () => settings) } };
    await expect(requireAiConsent(prisma, 'u1')).rejects.toMatchObject({ response: expect.objectContaining({ error: 'ai_consent_required' }) });
  });
  it('accepts explicit current permission', async () => {
    const prisma: any = { marvinUserSettings: { findUnique: jest.fn(async () => ({ aiConsentAt: new Date(), aiConsentVersion: 1 })) } };
    await expect(requireAiConsent(prisma, 'u1')).resolves.toBeUndefined();
  });
});
