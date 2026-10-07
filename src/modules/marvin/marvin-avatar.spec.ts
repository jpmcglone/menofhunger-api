import { MarvinController } from './marvin.controller';
import { MarvinMeService } from './services/marvin-me.service';

it('includes MARV’s video avatar alongside its profile poster', async () => {
  const prisma = { user: { findUnique: jest.fn().mockResolvedValueOnce({ premium: true }).mockResolvedValueOnce({
    avatarKey: 'avatars/poster.jpg', avatarVideoKey: 'avatars/clip.mp4', avatarVideoDurationMs: 7000,
  }) }, marvinUserSettings: { findUnique: jest.fn(async () => null) } };
  const config = { marvBot: () => ({ enabled: true, username: 'marv', displayName: 'MARV' }),
    r2: () => ({ publicBaseUrl: 'https://cdn.test' }), marvCredits: () => ({}) };
  const credits = { getSummary: jest.fn(async () => ({ credits: 1, maxCredits: 1, creditsPerDay: 1, lastRefilledAt: new Date() })) };
  const me = new MarvinMeService(prisma as never, config as never, credits as never,
    { getMarvUserId: async () => 'marv' } as never);
  const controller = new MarvinController(me, {} as never, {} as never);
  expect((await controller.getMe('viewer')).data.marv).toMatchObject({ avatarUrl: 'https://cdn.test/avatars/poster.jpg',
    avatarVideo: { id: 'avatars/clip.mp4', url: 'https://cdn.test/avatars/clip.mp4', durationMs: 7000 } });
});
