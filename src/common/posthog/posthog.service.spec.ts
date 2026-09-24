import { PostHog } from 'posthog-node';
import { PosthogService } from './posthog.service';

jest.mock('posthog-node', () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    capture: jest.fn(),
    isFeatureEnabled: jest.fn(),
    getFeatureFlag: jest.fn(),
    shutdown: jest.fn(),
  })),
}));

const VALID_KEY = 'phc_abcdefghijklmnopqrstuvwxyz';

function makeService(key: string | null) {
  const appConfig = {
    posthogApiKey: () => key,
    posthogHost: () => 'https://us.i.posthog.com',
    posthogFeatureFlagsKey: () => null,
    isProd: () => false,
  } as never;
  const svc = new PosthogService(appConfig);
  const client = (PostHog as unknown as jest.Mock).mock.results.at(-1)?.value;
  return { svc, client };
}

describe('PosthogService feature flags', () => {
  beforeEach(() => (PostHog as unknown as jest.Mock).mockClear());

  it('returns the fallback when PostHog is not configured', async () => {
    const { svc } = makeService(null);

    await expect(svc.isFeatureEnabled('new-feed', 'user_1')).resolves.toBe(false);
    await expect(svc.isFeatureEnabled('kill-switch', 'user_1', { fallback: true })).resolves.toBe(true);
    await expect(svc.getFeatureFlag('experiment', 'user_1')).resolves.toBeNull();
  });

  it('returns the evaluated flag value', async () => {
    const { svc, client } = makeService(VALID_KEY);
    client.isFeatureEnabled.mockResolvedValue(true);
    client.getFeatureFlag.mockResolvedValue('variant-b');

    await expect(svc.isFeatureEnabled('new-feed', 'user_1')).resolves.toBe(true);
    await expect(svc.getFeatureFlag('experiment', 'user_1')).resolves.toBe('variant-b');
  });

  it('falls back when the flag is unknown or evaluation fails', async () => {
    const { svc, client } = makeService(VALID_KEY);
    client.isFeatureEnabled.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('timeout'));

    await expect(svc.isFeatureEnabled('missing', 'user_1', { fallback: true })).resolves.toBe(true);
    await expect(svc.isFeatureEnabled('slow', 'user_1')).resolves.toBe(false);
  });
});

 it('tags API events and omits private text without losing funnel fields', () => {
    const { svc, client } = makeService(VALID_KEY);
    svc.capture('member', 'search_performed', { query: 'private text', email: 'private@example.com', result_count: 3 });
    expect(client.capture).toHaveBeenCalledWith({ distinctId: 'member', event: 'search_performed', properties: { result_count: 3, platform: 'api', environment: 'development' } });
  });
