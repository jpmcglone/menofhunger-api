import { EmailPreferencesService } from './email-preferences.service';

function setup() {
  const user = { email: 'member@example.com', emailVerifiedAt: new Date(), bannedAt: null, deletionRequestedAt: null, notificationPreferences: { emailOnboarding: true } };
  const prisma = { emailSuppression: { findUnique: jest.fn(async () => null) }, user: { findUnique: jest.fn(async () => user) }, notificationPreferences: { upsert: jest.fn() } };
  const config = { sessionHmacSecret: () => 'test-secret', emailPublicApiUrl: () => 'https://api.example/v1' };
  return { prisma, user, service: new EmailPreferencesService(prisma as never, config as never) };
}

describe('email family preferences and suppression', () => {
  it('preserves suppression identity through authentication secret rotation', () => {
    const { prisma, service } = setup();
    const rotated = new EmailPreferencesService(prisma as never, { sessionHmacSecret: () => 'rotated-secret' } as never);
    expect(service.recipientHash(' Member@Example.com ')).toBe(rotated.recipientHash('member@example.com'));
  });

  it('unsubscribes only the signed family without login and is repeatable', async () => {
    const { prisma, service } = setup();
    const token = service.unsubscribeToken('user', 'member@example.com', 'emailOnboarding');
    await expect(service.unsubscribe(token)).resolves.toEqual({ ok: true, family: 'getting-started tips' });
    await service.unsubscribe(token);
    expect(prisma.notificationPreferences.upsert).toHaveBeenCalledWith({ where: { userId: 'user' }, create: { userId: 'user', emailOnboarding: false }, update: { emailOnboarding: false } });
  });

  it('rejects tampering and invalidates links when the account email changes', async () => {
    const { service, user, prisma } = setup();
    const token = service.unsubscribeToken('user', 'member@example.com', 'emailOnboarding');
    await expect(service.unsubscribe(token.slice(0, -1) + 'x')).rejects.toThrow('Invalid unsubscribe');
    user.email = 'replacement@example.com';
    await expect(service.unsubscribe(token)).rejects.toThrow('no longer valid');
    expect(prisma.notificationPreferences.upsert).not.toHaveBeenCalled();
  });

  it('rechecks preferences, address verification, active state, and suppression before every send', async () => {
    const { service, user, prisma } = setup();
    const req = { to: 'member@example.com', subject: 'Hi', text: 'Hi', userId: 'user', preference: 'emailOnboarding' as const };
    expect(await service.blockedReason(req)).toBeNull();
    user.notificationPreferences.emailOnboarding = false;
    expect(await service.blockedReason(req)).toBe('email_preference_disabled');
    user.email = 'new@example.com';
    expect(await service.blockedReason(req)).toBe('email_recipient_changed');
    prisma.emailSuppression.findUnique.mockResolvedValue({ reason: 'complaint' } as never);
    expect(await service.blockedReason({ ...req, category: 'transactional' })).toBe('email_suppressed');
  });

  it('allows only account security notices to use the previous verified email snapshot', async () => {
    const { service } = setup();
    const req = { to: 'old@example.com', subject: 'Email changed', text: 'Hi', userId: 'user', recipientMode: 'previous' as const };
    expect(await service.blockedReason({ ...req, category: 'transactional' })).toBeNull();
    expect(await service.blockedReason({ ...req, category: 'engagement' })).toBe('email_invalid_recipient_mode');
  });

  it('adds a visible family link plus standard one-click headers', () => {
    const { service } = setup();
    const result = service.decorate({ to: 'member@example.com', userId: 'user', preference: 'emailOnboarding', subject: 'Hi', text: 'Hi', html: '<body>Hi</body>' });
    expect(result.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(result.headers?.['List-Unsubscribe']).toContain('https://api.example/v1/email/unsubscribe?token=family.');
    expect(result.html).toContain('Unsubscribe from getting-started tips');
    expect(result.text).toContain('Unsubscribe from getting-started tips');
  });
});
