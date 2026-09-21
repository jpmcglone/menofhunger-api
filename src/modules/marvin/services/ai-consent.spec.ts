import { requireAiConsent } from './ai-consent';

describe('AI permission', () => {
  it.each([null, { aiConsentAt: null, aiConsentVersion: 1 }, { aiConsentAt: new Date(), aiConsentVersion: 0 }])(
    'records current permission when missing: %p',
    async (settings) => {
      const upsert = jest.fn(async () => ({}));
      const prisma: any = {
        marvinUserSettings: { findUnique: jest.fn(async () => settings), upsert },
      };
      await expect(requireAiConsent(prisma, 'u1')).resolves.toBeUndefined();
      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1' } }));
    },
  );
  it('leaves an already-current permission alone', async () => {
    const upsert = jest.fn(async () => ({}));
    const prisma: any = {
      marvinUserSettings: {
        findUnique: jest.fn(async () => ({ aiConsentAt: new Date(), aiConsentVersion: 1 })),
        upsert,
      },
    };
    await expect(requireAiConsent(prisma, 'u1')).resolves.toBeUndefined();
    expect(upsert).not.toHaveBeenCalled();
  });
});
