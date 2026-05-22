import { AuthService } from './auth.service';
import { SESSION_RENEWAL_THRESHOLD_DAYS, SESSION_TTL_DAYS } from './auth.constants';
import { hmacSha256Hex, randomSessionToken } from './auth.utils';

const HMAC_SECRET = 'test-secret';

function makeMinimalUser(overrides?: Record<string, unknown>) {
  return {
    id: 'user-1',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    username: 'tester',
    usernameIsSet: true,
    name: 'Tester',
    phone: '+15555555555',
    email: null,
    emailVerifiedAt: null,
    emailVerificationRequestedAt: null,
    bio: null,
    website: null,
    locationInput: null,
    locationDisplay: null,
    locationZip: null,
    locationCity: null,
    locationCounty: null,
    locationState: null,
    locationCountry: null,
    birthdate: null,
    interests: [],
    menOnlyConfirmed: false,
    avatarKey: null,
    avatarUpdatedAt: null,
    bannerKey: null,
    bannerUpdatedAt: null,
    bannedAt: null,
    bannedReason: null,
    bannedByAdminId: null,
    pinnedPostId: null,
    premium: false,
    premiumPlus: false,
    isOrganization: false,
    verifiedStatus: 'none',
    verifiedAt: null,
    unverifiedAt: null,
    siteAdmin: false,
    stewardBadgeEnabled: false,
    followVisibility: 'public',
    birthdayVisibility: 'monthDay',
    featureToggles: null,
    coins: 0,
    checkinStreakDays: 0,
    longestStreakDays: 0,
    lastCheckinDayKey: null,
    ...overrides,
  };
}

function makeSession(overrides: { expiresAt: Date; user?: any }) {
  const user = overrides.user ?? makeMinimalUser();
  return {
    id: 'session-1',
    createdAt: new Date(),
    expiresAt: overrides.expiresAt,
    revokedAt: null,
    tokenHash: '',
    userId: user.id,
    user,
  };
}

function makeService(overrides?: { prisma?: any }) {
  const token = randomSessionToken();
  const tokenHash = hmacSha256Hex(HMAC_SECRET, token);

  const defaultSession = makeSession({
    expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60_000),
  });
  defaultSession.tokenHash = tokenHash;

  const prisma =
    overrides?.prisma ??
    ({
      session: {
        findFirst: jest.fn(async () => defaultSession),
        update: jest.fn(async () => defaultSession),
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
      post: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      user: { update: jest.fn() },
      phoneOtp: { findFirst: jest.fn(async () => null) },
    } as any);

  const appConfig = {
    sessionHmacSecret: jest.fn(() => HMAC_SECRET),
    isProd: jest.fn(() => false),
    disableTwilioInDev: jest.fn(() => true),
    twilioVerify: jest.fn(() => null),
    cookieDomain: jest.fn(() => undefined),
    r2: jest.fn(() => null),
  } as any;

  const cacheInvalidation = {
    deleteSessionUser: jest.fn(async () => undefined),
    deleteSessionFull: jest.fn(async () => undefined),
  } as any;

  const redis = {
    getJson: jest.fn(async () => null),
    setJson: jest.fn(async () => undefined),
  } as any;

  const otpProvider = { send: jest.fn(), verify: jest.fn() } as any;
  const posthog = { capture: jest.fn() } as any;
  const slack = { send: jest.fn(), notifySignup: jest.fn() } as any;
  const requestCache = { get: jest.fn(() => undefined), set: jest.fn() } as any;
  const presence = { markSeenFromHttp: jest.fn(), persistLastSeenAt: jest.fn(), persistLastOnlineAt: jest.fn() } as any;

  const svc = new AuthService(prisma, appConfig, cacheInvalidation, redis, otpProvider, posthog, slack, requestCache, presence);
  return { svc, prisma, token, tokenHash, presence };
}

// ---------------------------------------------------------------------------

describe('AuthService.meFromSessionToken — sliding window renewal', () => {
  it('renews a session that is within the renewal threshold', async () => {
    const daysUntilExpiry = SESSION_RENEWAL_THRESHOLD_DAYS - 1; // e.g. 6 days → below threshold
    const expiresAt = new Date(Date.now() + daysUntilExpiry * 24 * 60 * 60_000);
    const session = makeSession({ expiresAt });
    const token = randomSessionToken();
    session.tokenHash = hmacSha256Hex(HMAC_SECRET, token);

    const { svc, prisma } = makeService({
      prisma: {
        session: {
          findFirst: jest.fn(async () => session),
          update: jest.fn(async () => session),
        },
        post: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
        user: { update: jest.fn() },
      },
    });

    const result = await svc.meFromSessionToken(token);

    expect(result).not.toBeNull();
    expect(result!.renewed).toBe(true);

    // The update must extend expiresAt by ~SESSION_TTL_DAYS from now.
    expect(prisma.session.update).toHaveBeenCalledTimes(1);
    const updateCall = (prisma.session.update as jest.Mock).mock.calls[0][0];
    const updatedExpiry: Date = updateCall.data.expiresAt;
    const expectedMinExpiry = new Date(
      Date.now() + (SESSION_TTL_DAYS - 1) * 24 * 60 * 60_000,
    );
    expect(updatedExpiry.getTime()).toBeGreaterThanOrEqual(expectedMinExpiry.getTime());
    expect(result!.expiresAt).toEqual(updatedExpiry);
  });

  it('does NOT renew a session that still has plenty of time remaining', async () => {
    const daysUntilExpiry = SESSION_RENEWAL_THRESHOLD_DAYS + 5; // e.g. 12 days → above threshold
    const expiresAt = new Date(Date.now() + daysUntilExpiry * 24 * 60 * 60_000);
    const session = makeSession({ expiresAt });
    const token = randomSessionToken();
    session.tokenHash = hmacSha256Hex(HMAC_SECRET, token);

    const { svc, prisma } = makeService({
      prisma: {
        session: {
          findFirst: jest.fn(async () => session),
          update: jest.fn(async () => session),
        },
        post: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
        user: { update: jest.fn() },
      },
    });

    const result = await svc.meFromSessionToken(token);

    expect(result).not.toBeNull();
    expect(result!.renewed).toBe(false);
    expect(prisma.session.update).not.toHaveBeenCalled();
    // expiresAt should be unchanged from the original session value.
    expect(result!.expiresAt).toEqual(expiresAt);
  });

  it('rejects an expired session and returns null', async () => {
    // Prisma's findFirst returns null for expired sessions because the query
    // includes `expiresAt: { gt: now }`. Simulate that here.
    const token = randomSessionToken();

    const { svc, prisma } = makeService({
      prisma: {
        session: {
          findFirst: jest.fn(async () => null), // expired → no row returned
          update: jest.fn(),
        },
        post: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
        user: { update: jest.fn() },
      },
    });

    const result = await svc.meFromSessionToken(token);

    expect(result).toBeNull();
    expect(prisma.session.update).not.toHaveBeenCalled();
  });
});

describe('AuthService.meFromSessionToken — request-scoped memoization', () => {
  it('reuses a cached SessionResult on the second call with the same token (per-request)', async () => {
    const session = makeSession({
      expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60_000),
    });
    const token = randomSessionToken();
    session.tokenHash = hmacSha256Hex(HMAC_SECRET, token);

    // Real Map-backed RequestCacheService stand-in: lets us assert that
    // a second call short-circuits via the cache without touching Redis/DB again.
    const store = new Map<string, unknown>();
    const requestCache: any = {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
    };
    const findFirst = jest.fn(async () => session);
    const getJson = jest.fn(async () => null);

    const prisma: any = {
      session: { findFirst, update: jest.fn() },
      post: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      user: { update: jest.fn() },
    };
    const appConfig: any = {
      sessionHmacSecret: jest.fn(() => HMAC_SECRET),
      r2: jest.fn(() => null),
    };
    const redis: any = { getJson, setJson: jest.fn(async () => undefined) };
    const cacheInvalidation: any = { deleteSessionFull: jest.fn(async () => undefined) };
    const otpProvider: any = { send: jest.fn(), verify: jest.fn() };
    const posthog: any = { capture: jest.fn() };
    const slack: any = { send: jest.fn(), notifySignup: jest.fn() };
    const presence: any = { markSeenFromHttp: jest.fn(), persistLastSeenAt: jest.fn(), persistLastOnlineAt: jest.fn() };

    const svc = new AuthService(
      prisma,
      appConfig,
      cacheInvalidation,
      redis,
      otpProvider,
      posthog,
      slack,
      requestCache,
      presence,
    );

    const a = await svc.meFromSessionToken(token);
    const b = await svc.meFromSessionToken(token);

    expect(a).not.toBeNull();
    expect(b).toBe(a); // same reference — request cache short-circuit
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it('returns the same result for 5 concurrent calls with the same token (single-flight)', async () => {
    const session = makeSession({
      expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60_000),
    });
    const token = randomSessionToken();
    session.tokenHash = hmacSha256Hex(HMAC_SECRET, token);

    // Mocks must be slow enough that the 5 concurrent callers all queue up
    // before the first one resolves. With single-flight, only the first
    // caller hits Redis/DB; the others share that promise.
    const findFirst = jest.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(session), 25)),
    );
    const getJson = jest.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(null), 5)),
    );

    const store = new Map<string, unknown>();
    const requestCache: any = {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
    };
    const prisma: any = {
      session: { findFirst, update: jest.fn() },
      post: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      user: { update: jest.fn() },
    };
    const appConfig: any = {
      sessionHmacSecret: jest.fn(() => HMAC_SECRET),
      r2: jest.fn(() => null),
    };
    const redis: any = { getJson, setJson: jest.fn(async () => undefined) };
    const cacheInvalidation: any = { deleteSessionFull: jest.fn(async () => undefined) };
    const otpProvider: any = { send: jest.fn(), verify: jest.fn() };
    const posthog: any = { capture: jest.fn() };
    const slack: any = { send: jest.fn(), notifySignup: jest.fn() };
    const presence: any = { markSeenFromHttp: jest.fn(), persistLastSeenAt: jest.fn(), persistLastOnlineAt: jest.fn() };

    const svc = new AuthService(
      prisma,
      appConfig,
      cacheInvalidation,
      redis,
      otpProvider,
      posthog,
      slack,
      requestCache,
      presence,
    );

    // Simulate 5 concurrent requests all calling meFromSessionToken with the
    // same cookie at the same instant. Each uses a fresh AsyncLocalStorage
    // store (different Map) so per-request memoization doesn't dedupe — only
    // process-level single-flight can.
    const stores = Array.from({ length: 5 }, () => new Map<string, unknown>());
    const original = requestCache.get;
    let currentStore: Map<string, unknown> | null = null;
    requestCache.get = (key: string) => (currentStore ? currentStore.get(key) : original(key));
    requestCache.set = (key: string, value: unknown) => {
      if (currentStore) currentStore.set(key, value);
      else store.set(key, value);
    };

    const results = await Promise.all(
      stores.map(async (s) => {
        currentStore = s;
        const r = await svc.meFromSessionToken(token);
        return r;
      }),
    );

    // All five callers see a result of the same shape.
    expect(results.every((r) => r !== null)).toBe(true);
    // Single-flight: only ONE underlying Redis lookup + ONE DB lookup,
    // shared across all 5 concurrent callers.
    expect(getJson).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('preloads viewer context into the request cache after a successful resolve', async () => {
    const userRow = makeMinimalUser({
      id: 'user-42',
      verifiedStatus: 'identity',
      premium: true,
      premiumPlus: false,
      siteAdmin: false,
      bannedAt: null,
    });
    const session = makeSession({
      expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60_000),
      user: userRow,
    });
    const token = randomSessionToken();
    session.tokenHash = hmacSha256Hex(HMAC_SECRET, token);

    const store = new Map<string, unknown>();
    const requestCache: any = {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
    };
    const prisma: any = {
      session: { findFirst: jest.fn(async () => session), update: jest.fn() },
      post: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      user: { update: jest.fn() },
    };
    const appConfig: any = {
      sessionHmacSecret: jest.fn(() => HMAC_SECRET),
      r2: jest.fn(() => null),
    };
    const redis: any = { getJson: jest.fn(async () => null), setJson: jest.fn(async () => undefined) };
    const cacheInvalidation: any = { deleteSessionFull: jest.fn(async () => undefined) };
    const otpProvider: any = { send: jest.fn(), verify: jest.fn() };
    const posthog: any = { capture: jest.fn() };
    const slack: any = { send: jest.fn(), notifySignup: jest.fn() };
    const presence: any = { markSeenFromHttp: jest.fn(), persistLastSeenAt: jest.fn(), persistLastOnlineAt: jest.fn() };

    const svc = new AuthService(
      prisma,
      appConfig,
      cacheInvalidation,
      redis,
      otpProvider,
      posthog,
      slack,
      requestCache,
      presence,
    );

    await svc.meFromSessionToken(token);

    // After a successful resolve, the viewer context for this user MUST be
    // preloaded under the same key ViewerContextService uses, so getViewer
    // becomes a free Map.get() in the same request.
    const preloaded = store.get('viewerContext:user-42') as
      | {
          id: string;
          verifiedStatus: string;
          premium: boolean;
          premiumPlus: boolean;
          siteAdmin: boolean;
          bannedAt: Date | null;
        }
      | undefined;

    expect(preloaded).toBeDefined();
    expect(preloaded!.id).toBe('user-42');
    expect(preloaded!.verifiedStatus).toBe('identity');
    expect(preloaded!.premium).toBe(true);
    expect(preloaded!.premiumPlus).toBe(false);
    expect(preloaded!.siteAdmin).toBe(false);
    expect(preloaded!.bannedAt).toBeNull();
  });

  it('preloads viewer context from a Redis cache hit too', async () => {
    const token = randomSessionToken();
    const tokenHash = hmacSha256Hex(HMAC_SECRET, token);
    const cachedDto = {
      id: 'user-42',
      verifiedStatus: 'identity',
      premium: true,
      premiumPlus: false,
      siteAdmin: true,
      bannedAt: null,
      // (other DTO fields irrelevant for the viewer-context preload)
    };

    const store = new Map<string, unknown>();
    const requestCache: any = {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
    };
    const findFirst = jest.fn();
    const prisma: any = {
      session: { findFirst, update: jest.fn() },
      post: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      user: { update: jest.fn() },
    };
    const appConfig: any = {
      sessionHmacSecret: jest.fn(() => HMAC_SECRET),
      r2: jest.fn(() => null),
    };
    const redis: any = {
      getJson: jest.fn(async () => ({
        user: cachedDto,
        sessionId: 'session-cached',
        expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60_000).toISOString(),
      })),
      setJson: jest.fn(async () => undefined),
    };
    const cacheInvalidation: any = { deleteSessionFull: jest.fn(async () => undefined) };
    const otpProvider: any = { send: jest.fn(), verify: jest.fn() };
    const posthog: any = { capture: jest.fn() };
    const slack: any = { send: jest.fn(), notifySignup: jest.fn() };
    const presence: any = { markSeenFromHttp: jest.fn(), persistLastSeenAt: jest.fn(), persistLastOnlineAt: jest.fn() };

    const svc = new AuthService(
      prisma,
      appConfig,
      cacheInvalidation,
      redis,
      otpProvider,
      posthog,
      slack,
      requestCache,
      presence,
    );

    const result = await svc.meFromSessionToken(token);
    expect(result).not.toBeNull();
    expect(findFirst).not.toHaveBeenCalled(); // Redis cache hit, no DB query

    const preloaded = store.get('viewerContext:user-42') as any;
    expect(preloaded).toBeDefined();
    expect(preloaded.id).toBe('user-42');
    expect(preloaded.premium).toBe(true);
    expect(preloaded.siteAdmin).toBe(true);
    expect(preloaded.bannedAt).toBeNull();

    // Quiet the unused-var lint warning on tokenHash (kept for clarity above).
    expect(tokenHash).toBeDefined();
  });
});

describe('AuthService.verifyPhoneCode — referral signup linking', () => {
  function makeResponse() {
    return {
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    } as any;
  }

  it('sets recruitedById while creating a new user when a valid premium referral code is supplied', async () => {
    const createdUser = makeMinimalUser({
      id: 'new-user',
      phone: '+15555550000',
      username: null,
      usernameIsSet: false,
      recruitedById: 'recruiter-1',
    });
    const prisma = {
      user: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => ({ id: 'recruiter-1', premium: true })),
        create: jest.fn(async () => createdUser),
      },
      phoneOtp: {
        findFirst: jest.fn(async () => null),
        update: jest.fn(),
      },
      follow: {
        create: jest.fn(async () => ({})),
      },
      session: {
        create: jest.fn(async () => ({ id: 'session-1' })),
      },
      post: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    };
    const { svc } = makeService({ prisma });

    const result = await svc.verifyPhoneCode('+15555550000', '000000', makeResponse(), 'john-code');

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { referralCode: 'JOHN-CODE' },
      select: { id: true, premium: true },
    });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        phone: '+15555550000',
        username: null,
        usernameIsSet: false,
        recruitedById: 'recruiter-1',
        lastSeenAt: expect.any(Date),
        lastOnlineAt: expect.any(Date),
      }),
    });
    expect(prisma.follow.create).toHaveBeenCalledWith({
      data: { followerId: 'new-user', followingId: 'recruiter-1' },
    });
    expect(result.referralApplied).toBe(true);
  });

  it('does not link a recruiter for existing users even when a referral code is supplied', async () => {
    const existingUser = makeMinimalUser({ id: 'existing-user', phone: '+15555550000' });
    const prisma = {
      user: {
        findUnique: jest.fn(async () => existingUser),
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      phoneOtp: {
        findFirst: jest.fn(async () => null),
        update: jest.fn(),
      },
      follow: {
        create: jest.fn(),
      },
      session: {
        create: jest.fn(async () => ({ id: 'session-1' })),
      },
      post: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    };
    const { svc } = makeService({ prisma });

    const result = await svc.verifyPhoneCode('+15555550000', '000000', makeResponse(), 'john-code');

    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.follow.create).not.toHaveBeenCalled();
    expect(result.referralApplied).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('AuthService.verifyPhoneCode — presence on signup', () => {
  function makeResponse() {
    return { cookie: jest.fn(), clearCookie: jest.fn() } as any;
  }

  it('seeds lastSeenAt and lastOnlineAt when creating a new user', async () => {
    const newUser = makeMinimalUser({ id: 'brand-new', phone: '+15550001234', username: null, usernameIsSet: false });
    const prisma = {
      user: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => null),
        create: jest.fn(async () => newUser),
      },
      phoneOtp: { findFirst: jest.fn(async () => null), update: jest.fn() },
      follow: { create: jest.fn() },
      session: { create: jest.fn(async () => ({ id: 'session-1' })) },
      post: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    };
    const { svc } = makeService({ prisma });
    await svc.verifyPhoneCode('+15550001234', '000000', makeResponse());

    const createCall = (prisma.user.create as jest.Mock).mock.calls[0][0];
    expect(createCall.data.lastSeenAt).toBeInstanceOf(Date);
    expect(createCall.data.lastOnlineAt).toBeInstanceOf(Date);
  });

  it('calls markSeenFromHttp after successful login', async () => {
    const existingUser = makeMinimalUser({ id: 'existing-user', phone: '+15550001234' });
    const prisma = {
      user: {
        findUnique: jest.fn(async () => existingUser),
        findFirst: jest.fn(async () => null),
        create: jest.fn(),
      },
      phoneOtp: { findFirst: jest.fn(async () => null), update: jest.fn() },
      follow: { create: jest.fn() },
      session: { create: jest.fn(async () => ({ id: 'session-1' })) },
      post: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    };
    const { svc, presence } = makeService({ prisma });
    await svc.verifyPhoneCode('+15550001234', '000000', makeResponse());

    expect(presence.markSeenFromHttp).toHaveBeenCalledWith(existingUser.id);
  });
});
