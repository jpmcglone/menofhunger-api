import { BillingSideEffectsHandler } from './billing-side-effects.handler';

function makeHandler(overrides: { prisma?: any; notifications?: any } = {}) {
  const prisma = overrides.prisma ?? {
    user: {
      findUnique: jest.fn(),
    },
  };
  const notifications = overrides.notifications ?? {
    upsertPremiumStatusNotification: jest.fn(async () => undefined),
  };
  const registry = { register: jest.fn() } as any;
  const handler = new BillingSideEffectsHandler(prisma, notifications, registry);
  return { handler, prisma, notifications, registry };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('BillingSideEffectsHandler.onModuleInit', () => {
  it('registers billing.premium.changed', () => {
    const { handler, registry } = makeHandler();
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(
      'billing.premium.changed',
      expect.any(Function),
    );
  });
});

describe('BillingSideEffectsHandler — billing.premium.changed', () => {
  function triggerHandler(
    handler: BillingSideEffectsHandler,
    payload: { userId: string; direction: 'started' | 'ended' },
  ) {
    return (handler as any).onPremiumChanged(payload);
  }

  it('writes premium_started when direction=started and user.premium=true', async () => {
    const { handler, prisma, notifications } = makeHandler();
    prisma.user.findUnique.mockResolvedValue({ premium: true, premiumPlus: false });

    await triggerHandler(handler, { userId: 'u1', direction: 'started' });

    expect(notifications.upsertPremiumStatusNotification).toHaveBeenCalledWith({
      recipientUserId: 'u1',
      kind: 'premium_started',
      isPremiumPlus: false,
    });
  });

  it('writes premium_started with isPremiumPlus=true when user is premium+', async () => {
    const { handler, prisma, notifications } = makeHandler();
    prisma.user.findUnique.mockResolvedValue({ premium: true, premiumPlus: true });

    await triggerHandler(handler, { userId: 'u1', direction: 'started' });

    expect(notifications.upsertPremiumStatusNotification).toHaveBeenCalledWith({
      recipientUserId: 'u1',
      kind: 'premium_started',
      isPremiumPlus: true,
    });
  });

  it('writes premium_ended when direction=ended and user.premium=false', async () => {
    const { handler, prisma, notifications } = makeHandler();
    prisma.user.findUnique.mockResolvedValue({ premium: false, premiumPlus: false });

    await triggerHandler(handler, { userId: 'u1', direction: 'ended' });

    expect(notifications.upsertPremiumStatusNotification).toHaveBeenCalledWith({
      recipientUserId: 'u1',
      kind: 'premium_ended',
      isPremiumPlus: false,
    });
  });

  it('skips when direction=started but DB shows premium=false (stale retry)', async () => {
    const { handler, prisma, notifications } = makeHandler();
    prisma.user.findUnique.mockResolvedValue({ premium: false, premiumPlus: false });

    await triggerHandler(handler, { userId: 'u1', direction: 'started' });

    expect(notifications.upsertPremiumStatusNotification).not.toHaveBeenCalled();
  });

  it('skips when direction=ended but DB shows premium=true (stale retry)', async () => {
    const { handler, prisma, notifications } = makeHandler();
    prisma.user.findUnique.mockResolvedValue({ premium: true, premiumPlus: false });

    await triggerHandler(handler, { userId: 'u1', direction: 'ended' });

    expect(notifications.upsertPremiumStatusNotification).not.toHaveBeenCalled();
  });

  it('skips silently when user is not found', async () => {
    const { handler, prisma, notifications } = makeHandler();
    prisma.user.findUnique.mockResolvedValue(null);

    await triggerHandler(handler, { userId: 'missing', direction: 'started' });

    expect(notifications.upsertPremiumStatusNotification).not.toHaveBeenCalled();
  });
});
