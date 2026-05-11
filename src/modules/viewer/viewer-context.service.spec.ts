import { VerifiedStatus } from '@prisma/client';
import { ViewerContextService } from './viewer-context.service';

function makeService() {
  const prisma = {} as any;
  const requestCache = { get: jest.fn(), set: jest.fn() } as any;
  return new ViewerContextService(prisma, requestCache);
}

function makeServiceWithStore(opts?: {
  prismaUser?: { id: string; verifiedStatus: any; premium: boolean; premiumPlus: boolean; siteAdmin: boolean; bannedAt: Date | null } | null;
  preloaded?: Record<string, unknown>;
}) {
  const store = new Map<string, unknown>(Object.entries(opts?.preloaded ?? {}));
  const findUnique = jest.fn(async () => opts?.prismaUser ?? null);
  const prisma = { user: { findUnique } } as any;
  const requestCache = {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
  } as any;
  return { svc: new ViewerContextService(prisma, requestCache), findUnique, store };
}

describe('ViewerContextService.allowedPostVisibilities', () => {
  it('returns public only for anon', () => {
    const svc = makeService();
    expect(svc.allowedPostVisibilities(null)).toEqual(['public']);
  });

  it('includes verifiedOnly for verified viewers', () => {
    const svc = makeService();
    expect(
      svc.allowedPostVisibilities({
        verifiedStatus: VerifiedStatus.identity,
        premium: false,
        premiumPlus: false,
      } as any),
    ).toEqual(['public', 'verifiedOnly']);
  });

  it('includes premiumOnly for premium viewers', () => {
    const svc = makeService();
    expect(
      svc.allowedPostVisibilities({
        verifiedStatus: VerifiedStatus.none,
        premium: true,
        premiumPlus: false,
      } as any),
    ).toEqual(['public', 'premiumOnly']);
  });

  it('treats premiumPlus as premium for visibility', () => {
    const svc = makeService();
    expect(
      svc.allowedPostVisibilities({
        verifiedStatus: VerifiedStatus.none,
        premium: false,
        premiumPlus: true,
      } as any),
    ).toEqual(['public', 'premiumOnly']);
  });

  it('includes both verifiedOnly and premiumOnly when applicable', () => {
    const svc = makeService();
    expect(
      svc.allowedPostVisibilities({
        verifiedStatus: VerifiedStatus.identity,
        premium: false,
        premiumPlus: true,
      } as any),
    ).toEqual(['public', 'verifiedOnly', 'premiumOnly']);
  });
});

describe('ViewerContextService.getViewer — request cache reuse', () => {
  it('falls back to a prisma.user.findUnique on a cold cache (current behavior)', async () => {
    const dbUser = {
      id: 'user-1',
      verifiedStatus: VerifiedStatus.none,
      premium: false,
      premiumPlus: false,
      siteAdmin: false,
      bannedAt: null,
    } as any;
    const { svc, findUnique } = makeServiceWithStore({ prismaUser: dbUser });

    const v = await svc.getViewer('user-1');

    expect(v).toEqual(dbUser);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: {
        id: true,
        verifiedStatus: true,
        premium: true,
        premiumPlus: true,
        siteAdmin: true,
        bannedAt: true,
      },
    });
  });

  it('returns the preloaded viewer context without calling prisma when the cache key is set', async () => {
    const preloadedViewer = {
      id: 'user-1',
      verifiedStatus: VerifiedStatus.identity,
      premium: true,
      premiumPlus: false,
      siteAdmin: false,
      bannedAt: null,
    };
    const { svc, findUnique } = makeServiceWithStore({
      prismaUser: null,
      preloaded: { 'viewerContext:user-1': preloadedViewer },
    });

    const v = await svc.getViewer('user-1');

    expect(v).toEqual(preloadedViewer);
    // Critical: NO DB query, even though prisma.user.findUnique is wired up.
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('still throws via assertNotBanned when preloaded viewer carries bannedAt', async () => {
    const preloadedBanned = {
      id: 'user-banned',
      verifiedStatus: VerifiedStatus.none,
      premium: false,
      premiumPlus: false,
      siteAdmin: false,
      bannedAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const { svc, findUnique } = makeServiceWithStore({
      prismaUser: null,
      preloaded: { 'viewerContext:user-banned': preloadedBanned },
    });

    const v = await svc.getViewer('user-banned');
    expect(findUnique).not.toHaveBeenCalled();
    expect(() => svc.assertNotBanned(v)).toThrow();
  });
});

