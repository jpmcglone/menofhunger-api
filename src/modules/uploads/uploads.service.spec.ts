import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { UploadsService } from './uploads.service';

const R2_CFG = {
  accountId: 'acct',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  bucket: 'test-bucket',
  publicBaseUrl: 'https://cdn.example.test',
};

type Deps = {
  prisma: any;
  appConfig: any;
  publicProfileCache: any;
  usersMeRealtime: any;
  usersPublicRealtime: any;
};

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    prisma: {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      mediaContentHash: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => null),
        delete: jest.fn(async () => ({})),
        update: jest.fn(async () => ({})),
        upsert: jest.fn(async () => ({})),
      },
      mediaAsset: {
        findUnique: jest.fn(async () => null),
      },
    },
    appConfig: {
      r2: jest.fn(() => R2_CFG),
      isProd: jest.fn(() => false),
    },
    publicProfileCache: { invalidateForUser: jest.fn(async () => undefined) },
    usersMeRealtime: { emitMeUpdatedFromUser: jest.fn() },
    usersPublicRealtime: { emitPublicProfileUpdated: jest.fn(async () => undefined) },
    ...overrides,
  };
}

function makeService(overrides: Partial<Deps> = {}) {
  const deps = makeDeps(overrides);
  const service = new UploadsService(
    deps.prisma,
    deps.appConfig,
    deps.publicProfileCache,
    deps.usersMeRealtime,
    deps.usersPublicRealtime,
  );
  return { service, deps };
}

/**
 * Stub send() on the service's real S3 client (dispatching on command type).
 * The client itself stays real so presigning (which reads client config, not
 * the network) keeps working.
 */
function stubS3(
  service: UploadsService,
  impl: (commandName: string, input: any) => Promise<unknown> | unknown,
) {
  const send = jest.fn(async (cmd: any) => impl(cmd.constructor.name, cmd.input));
  (service as any).s3.send = send;
  return send;
}

function fullUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    phone: '+15555550100',
    email: null,
    emailVerifiedAt: null,
    emailVerificationRequestedAt: null,
    username: 'alice',
    usernameIsSet: true,
    name: 'Alice',
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
    menOnlyConfirmed: true,
    siteAdmin: false,
    featureToggles: [],
    bannedAt: null,
    bannedReason: null,
    bannedByAdminId: null,
    premium: false,
    premiumPlus: false,
    isOrganization: false,
    stewardBadgeEnabled: false,
    verifiedStatus: 'none',
    verifiedAt: null,
    unverifiedAt: null,
    followVisibility: 'everyone',
    birthdayVisibility: 'monthDay',
    avatarKey: null,
    avatarUpdatedAt: null,
    bannerKey: null,
    bannerUpdatedAt: null,
    pinnedPostId: null,
    coins: 0,
    checkinStreakDays: 0,
    lastCheckinDayKey: null,
    longestStreakDays: 0,
    locationPromptSkipped: false,
    ...overrides,
  };
}

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .png()
    .toBuffer();
}

async function makeJpeg(width: number, height: number, orientation?: number): Promise<Buffer> {
  let pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  }).jpeg();
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  return pipeline.toBuffer();
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('UploadsService configuration guard', () => {
  it('throws ServiceUnavailableException when R2 is not configured', async () => {
    const { service } = makeService({
      appConfig: { r2: jest.fn(() => null), isProd: jest.fn(() => false) },
    });

    await expect(service.initAvatarUpload('u1', 'image/jpeg')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});

describe('UploadsService.initAvatarUpload', () => {
  it('rejects unsupported content types', async () => {
    const { service } = makeService();

    await expect(service.initAvatarUpload('u1', 'image/svg+xml')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('returns a dev-prefixed key, signed URL, and size cap', async () => {
    const { service } = makeService();

    const result = await service.initAvatarUpload('u1', 'image/jpeg');

    expect(result.key).toMatch(/^dev\/avatars\/u1\/[0-9a-f-]+\.jpg$/);
    expect(typeof result.uploadUrl).toBe('string');
    expect(result.uploadUrl.length).toBeGreaterThan(0);
    expect(result.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(result.maxBytes).toBe(5 * 1024 * 1024);
  });
});

describe('UploadsService.initBannerUpload', () => {
  it('uses the covers prefix (not "banners") and advertises 3:1', async () => {
    const { service } = makeService();

    const result = await service.initBannerUpload('u1', 'image/png');

    expect(result.key).toMatch(/^dev\/covers\/u1\/[0-9a-f-]+\.png$/);
    expect(result.aspectRatio).toBe('3:1');
    expect(result.maxBytes).toBe(8 * 1024 * 1024);
  });
});

describe('UploadsService.initPostMediaUpload', () => {
  it('rejects video uploads for non-premium users', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({ premium: false, premiumPlus: false });

    await expect(service.initPostMediaUpload('u1', 'video/mp4')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('caps premium video uploads at 250MB', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({ premium: true, premiumPlus: false });

    const result = await service.initPostMediaUpload('u1', 'video/mp4');

    expect(result.maxBytes).toBe(250 * 1024 * 1024);
    expect(result.key).toMatch(/^dev\/uploads\/u1\/videos\/[0-9a-f-]+\.mp4$/);
  });

  it('caps premium+ video uploads at 500MB', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({ premium: true, premiumPlus: true });

    const result = await service.initPostMediaUpload('u1', 'video/quicktime');

    expect(result.maxBytes).toBe(500 * 1024 * 1024);
  });

  it('rejects GIFs for thumbnail uploads but allows them for posts', async () => {
    const { service } = makeService();

    await expect(
      service.initPostMediaUpload('u1', 'image/gif', { purpose: 'thumbnail' }),
    ).rejects.toThrow(BadRequestException);

    const result = await service.initPostMediaUpload('u1', 'image/gif');
    expect(result.key).toMatch(/\/images\/[0-9a-f-]+\.gif$/);
  });

  it('returns skipUpload for a known content hash whose object still exists', async () => {
    const { service, deps } = makeService();
    deps.prisma.mediaContentHash.findUnique.mockResolvedValue({
      contentHash: 'abc',
      r2Key: 'dev/uploads/other/images/existing.jpg',
      kind: 'image',
    });
    deps.prisma.mediaAsset.findUnique.mockResolvedValue(null);
    const send = stubS3(service, () => ({}));

    const result = await service.initPostMediaUpload('u1', 'image/jpeg', { contentHash: 'ABC' });

    expect(result).toEqual(
      expect.objectContaining({
        key: 'dev/uploads/other/images/existing.jpg',
        skipUpload: true,
      }),
    );
    expect(send).toHaveBeenCalledTimes(1); // HeadObject existence check only
  });

  it('never reuses tombstoned (admin-deleted) media even when the hash matches', async () => {
    const { service, deps } = makeService();
    deps.prisma.mediaContentHash.findUnique.mockResolvedValue({
      contentHash: 'abc',
      r2Key: 'dev/uploads/other/images/tombstoned.jpg',
      kind: 'image',
    });
    deps.prisma.mediaAsset.findUnique.mockResolvedValue({ deletedAt: new Date(), r2DeletedAt: null });

    const result = await service.initPostMediaUpload('u1', 'image/jpeg', { contentHash: 'abc' });

    expect((result as any).skipUpload).toBeUndefined();
    expect(result.key).toMatch(/^dev\/uploads\/u1\/images\//);
    expect(deps.prisma.mediaContentHash.delete).toHaveBeenCalledWith({
      where: { contentHash: 'abc' },
    });
  });

  it('falls back to a fresh upload when the hashed object is missing in R2', async () => {
    const { service, deps } = makeService();
    deps.prisma.mediaContentHash.findUnique.mockResolvedValue({
      contentHash: 'abc',
      r2Key: 'dev/uploads/other/images/gone.jpg',
      kind: 'image',
    });
    deps.prisma.mediaAsset.findUnique.mockResolvedValue(null);
    stubS3(service, (name) => {
      if (name === 'HeadObjectCommand') {
        const err: any = new Error('not found');
        err.name = 'NotFound';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {};
    });

    const result = await service.initPostMediaUpload('u1', 'image/jpeg', { contentHash: 'abc' });

    expect((result as any).skipUpload).toBeUndefined();
    expect(result.key).toMatch(/^dev\/uploads\/u1\/images\//);
    expect(deps.prisma.mediaContentHash.delete).toHaveBeenCalledWith({
      where: { contentHash: 'abc' },
    });
  });
});

describe('UploadsService.commitAvatarUpload', () => {
  it("rejects keys outside the user's avatar prefix", async () => {
    const { service } = makeService();

    await expect(
      service.commitAvatarUpload('u1', 'dev/avatars/another-user/sneaky.jpg'),
    ).rejects.toThrow(BadRequestException);
  });

  it('deletes the object and rejects when the uploaded file is not an image', async () => {
    const { service } = makeService();
    const send = stubS3(service, (name) => {
      if (name === 'HeadObjectCommand') {
        return { ContentType: 'application/pdf', ContentLength: 100 };
      }
      return {};
    });

    await expect(service.commitAvatarUpload('u1', 'dev/avatars/u1/a.jpg')).rejects.toThrow(
      BadRequestException,
    );
    const commandNames = send.mock.calls.map((c: any[]) => c[0].constructor.name);
    expect(commandNames).toContain('DeleteObjectCommand');
  });

  it('deletes the object and rejects oversized avatars', async () => {
    const { service } = makeService();
    const send = stubS3(service, (name) => {
      if (name === 'HeadObjectCommand') {
        return { ContentType: 'image/png', ContentLength: 6 * 1024 * 1024 };
      }
      return {};
    });

    await expect(service.commitAvatarUpload('u1', 'dev/avatars/u1/a.png')).rejects.toThrow(
      BadRequestException,
    );
    const commandNames = send.mock.calls.map((c: any[]) => c[0].constructor.name);
    expect(commandNames).toContain('DeleteObjectCommand');
  });

  it('persists the new avatar, invalidates caches, emits realtime, and deletes the old object', async () => {
    const { service, deps } = makeService();
    const oldKey = 'dev/avatars/u1/old.png';
    const newKey = 'dev/avatars/u1/new.png';
    deps.prisma.user.findUnique.mockResolvedValue(fullUserRow({ avatarKey: oldKey }));
    const updated = fullUserRow({ avatarKey: newKey, avatarUpdatedAt: new Date() });
    deps.prisma.user.update.mockResolvedValue(updated);
    const send = stubS3(service, (name) => {
      if (name === 'HeadObjectCommand') {
        return { ContentType: 'image/png', ContentLength: 1024 };
      }
      return {};
    });

    const result = await service.commitAvatarUpload('u1', newKey);

    expect(result.user.id).toBe('u1');
    expect(result.user.avatarUrl).toContain(newKey);
    expect(deps.prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({ avatarKey: newKey }),
      }),
    );
    expect(deps.publicProfileCache.invalidateForUser).toHaveBeenCalledWith({
      id: 'u1',
      username: 'alice',
    });
    expect(deps.usersPublicRealtime.emitPublicProfileUpdated).toHaveBeenCalledWith('u1');
    expect(deps.usersMeRealtime.emitMeUpdatedFromUser).toHaveBeenCalledWith(updated, 'avatar_changed');

    const deletes = send.mock.calls.filter((c: any[]) => c[0].constructor.name === 'DeleteObjectCommand');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0].input.Key).toBe(oldKey);
  });
});

describe('UploadsService.commitBannerUpload', () => {
  function bannerS3(service: UploadsService, png: Buffer) {
    return stubS3(service, (name) => {
      if (name === 'HeadObjectCommand') {
        return { ContentType: 'image/png', ContentLength: png.length };
      }
      if (name === 'GetObjectCommand') {
        return { Body: Readable.from(png) };
      }
      return {};
    });
  }

  it('accepts a 3:1 banner and persists it', async () => {
    const { service, deps } = makeService();
    const png = await makePng(1500, 500);
    bannerS3(service, png);
    const key = 'dev/covers/u1/banner.png';
    deps.prisma.user.findUnique.mockResolvedValue(fullUserRow());
    deps.prisma.user.update.mockResolvedValue(fullUserRow({ bannerKey: key }));

    const result = await service.commitBannerUpload('u1', key);

    expect(result.user.bannerUrl).toContain(key);
    expect(deps.prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bannerKey: key }) }),
    );
  });

  it('rejects banners with the wrong aspect ratio and cleans up the object', async () => {
    const { service } = makeService();
    const png = await makePng(800, 800);
    const send = bannerS3(service, png);

    await expect(service.commitBannerUpload('u1', 'dev/covers/u1/square.png')).rejects.toThrow(
      /3:1/,
    );
    const commandNames = send.mock.calls.map((c: any[]) => c[0].constructor.name);
    expect(commandNames).toContain('DeleteObjectCommand');
  });

  it('rejects banners below the minimum dimensions', async () => {
    const { service } = makeService();
    const png = await makePng(300, 100); // 3:1 but too small
    bannerS3(service, png);

    await expect(service.commitBannerUpload('u1', 'dev/covers/u1/tiny.png')).rejects.toThrow(
      /too small/i,
    );
  });
});

describe('UploadsService EXIF orientation normalization', () => {
  it('re-encodes sideways JPEGs (EXIF orientation) and rewrites the object', async () => {
    const { service } = makeService();
    // 10x20 image stored with EXIF orientation 6 (rotate 90° CW to display).
    const jpeg = await makeJpeg(10, 20, 6);
    const send = jest.fn(async (cmd: any) => {
      if (cmd.constructor.name === 'GetObjectCommand') return { Body: Readable.from(jpeg) };
      return {};
    });

    const result = await (service as any).normalizeJpegOrientationIfNeeded({
      s3: { send },
      bucket: 'test-bucket',
      key: 'dev/avatars/u1/sideways.jpg',
      maxBytes: 5 * 1024 * 1024,
      cacheControl: 'public, max-age=31536000, immutable',
    });

    expect(result.didNormalize).toBe(true);
    // Rotation applied to pixels: 10x20 becomes 20x10.
    expect(result.width).toBe(20);
    expect(result.height).toBe(10);
    const puts = send.mock.calls.filter((c: any[]) => c[0].constructor.name === 'PutObjectCommand');
    expect(puts).toHaveLength(1);
    expect(puts[0][0].input.ContentType).toBe('image/jpeg');
  });

  it('leaves upright JPEGs untouched', async () => {
    const { service } = makeService();
    const jpeg = await makeJpeg(10, 20);
    const send = jest.fn(async (cmd: any) => {
      if (cmd.constructor.name === 'GetObjectCommand') return { Body: Readable.from(jpeg) };
      return {};
    });

    const result = await (service as any).normalizeJpegOrientationIfNeeded({
      s3: { send },
      bucket: 'test-bucket',
      key: 'dev/avatars/u1/upright.jpg',
      maxBytes: 5 * 1024 * 1024,
      cacheControl: 'public, max-age=31536000, immutable',
    });

    expect(result.didNormalize).toBe(false);
    expect(result.width).toBe(10);
    expect(result.height).toBe(20);
    const puts = send.mock.calls.filter((c: any[]) => c[0].constructor.name === 'PutObjectCommand');
    expect(puts).toHaveLength(0);
  });
});
