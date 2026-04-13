import { AuthService } from './auth.service';
import { SESSION_RENEWAL_THRESHOLD_DAYS, SESSION_TTL_DAYS } from './auth.constants';
import { hmacSha256Hex, randomSessionToken } from './auth.utils';

const HMAC_SECRET = 'test-secret';

function makeMinimalUser() {
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
  const slack = { send: jest.fn() } as any;

  const svc = new AuthService(prisma, appConfig, cacheInvalidation, redis, otpProvider, posthog, slack);
  return { svc, prisma, token, tokenHash };
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
