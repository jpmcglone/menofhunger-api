import { MarvinSideEffectsHandler } from './marvin-side-effects.handler';

function makeHandler(overrides: { canned?: any } = {}) {
  const canned = overrides.canned ?? {
    sendPremiumWelcomeDm: jest.fn(async () => ({ conversationId: 'c1', messageId: 'm1' })),
  };
  const registry = { register: jest.fn() } as any;
  const handler = new MarvinSideEffectsHandler(registry, canned);
  return { handler, canned, registry };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('MarvinSideEffectsHandler', () => {
  it('registers marv.premium.welcome', () => {
    const { handler, registry } = makeHandler();
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith('marv.premium.welcome', expect.any(Function));
  });

  it('sends the premium welcome DM for the user', async () => {
    const { handler, canned } = makeHandler();
    await (handler as any).onPremiumWelcome({ userId: 'u1' });
    expect(canned.sendPremiumWelcomeDm).toHaveBeenCalledWith('u1');
  });
});
