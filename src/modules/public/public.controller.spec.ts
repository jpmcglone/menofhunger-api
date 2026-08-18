import { NotFoundException } from '@nestjs/common';
import { PublicController } from './public.controller';
import { PostsService } from '../posts/posts.service';
import { PublicProfilesService } from '../users/public-profiles.service';

// Minimal PostDto shape for test assertions.
const makePostDto = (overrides: Record<string, unknown> = {}) => ({
  id: 'post-1',
  body: 'Hello world',
  visibility: 'public',
  isDraft: false,
  communityGroupId: null,
  media: [{ id: 'media-1', url: 'https://cdn.example.com/img.jpg', kind: 'image' }],
  author: { id: 'user-1', username: 'alice', avatarUrl: null },
  ...overrides,
});

const makeProfilePayload = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-1',
  username: 'alice',
  name: 'Alice',
  bio: 'Test bio',
  website: null,
  locationDisplay: null,
  locationZip: null,
  locationCity: null,
  locationCounty: null,
  locationState: null,
  locationCountry: null,
  birthdayDisplay: null,
  birthdayMonthDay: null,
  premium: false,
  premiumPlus: false,
  isOrganization: false,
  verifiedStatus: 'none',
  avatarUrl: null,
  bannerUrl: null,
  pinnedPostId: null,
  lastOnlineAt: null,
  checkinStreakDays: 0,
  longestStreakDays: 0,
  orgAffiliations: [],
  postCount: 42,
  articleCount: 3,
  inCrew: false,
  ...overrides,
});

function makePosts(overrides: Partial<Record<keyof PostsService, unknown>> = {}): PostsService {
  return {
    getPublicById: jest.fn(),
    ...overrides,
  } as unknown as PostsService;
}

function makeProfiles(overrides: Partial<Record<keyof PublicProfilesService, unknown>> = {}): PublicProfilesService {
  return {
    getAnonymousProfile: jest.fn(),
    ...overrides,
  } as unknown as PublicProfilesService;
}

function makeRes() {
  return { setHeader: jest.fn() } as unknown as import('express').Response;
}

// ── POST endpoint ──────────────────────────────────────────────────────────

describe('PublicController.getPost', () => {
  it('returns { data: postDto } for a public post', async () => {
    const dto = makePostDto();
    const posts = makePosts({ getPublicById: jest.fn(async () => dto) });
    const controller = new PublicController(posts, makeProfiles());
    const res = makeRes();

    const result = await controller.getPost('post-1', res);

    expect(result).toEqual({ data: dto });
    expect(posts.getPublicById).toHaveBeenCalledWith('post-1');
  });

  it('includes media and author in the returned DTO', async () => {
    const dto = makePostDto({
      media: [{ id: 'm1', url: 'https://cdn.example.com/photo.jpg', kind: 'image' }],
      author: { id: 'user-1', username: 'alice', avatarUrl: 'https://cdn.example.com/avatar.jpg' },
    });
    const posts = makePosts({ getPublicById: jest.fn(async () => dto) });
    const controller = new PublicController(posts, makeProfiles());
    const res = makeRes();

    const result = await controller.getPost('post-1', res);

    expect(result.data.media).toHaveLength(1);
    expect(result.data.author.username).toBe('alice');
  });

  it('sets Cache-Control: public, max-age=60, stale-while-revalidate=300', async () => {
    const posts = makePosts({ getPublicById: jest.fn(async () => makePostDto()) });
    const controller = new PublicController(posts, makeProfiles());
    const res = makeRes();

    await controller.getPost('post-1', res);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  });

  it.each([
    ['missing post', 'unknown-id'],
    ['private post', 'private-id'],
    ['draft post', 'draft-id'],
    ['group post', 'group-id'],
    ['verifiedOnly post', 'verified-id'],
    ['premiumOnly post', 'premium-id'],
  ])('propagates NotFoundException for %s', async (_label, postId) => {
    const posts = makePosts({
      getPublicById: jest.fn(async () => {
        throw new NotFoundException('Post not found.');
      }),
    });
    const controller = new PublicController(posts, makeProfiles());

    await expect(controller.getPost(postId, makeRes())).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ── USER endpoint ──────────────────────────────────────────────────────────

describe('PublicController.getProfile', () => {
  it('returns { data: payload } for a public profile by username', async () => {
    const payload = makeProfilePayload();
    const profiles = makeProfiles({
      getAnonymousProfile: jest.fn(async () => ({ payload, cache: 'miss' })),
    });
    const controller = new PublicController(makePosts(), profiles);
    const res = makeRes();

    const result = await controller.getProfile('alice', res);

    expect(result.data).toEqual(payload);
    expect(profiles.getAnonymousProfile).toHaveBeenCalledWith('alice');
  });

  it('returns { data: payload } for a public profile by user ID', async () => {
    const payload = makeProfilePayload({ id: 'user-abc' });
    const profiles = makeProfiles({
      getAnonymousProfile: jest.fn(async () => ({ payload, cache: 'miss' })),
    });
    const controller = new PublicController(makePosts(), profiles);

    const result = await controller.getProfile('user-abc', makeRes());

    expect(result.data).toEqual(expect.objectContaining({ id: 'user-abc' }));
  });

  it('always has lastOnlineAt: null (redacted for anonymous requests)', async () => {
    const payload = makeProfilePayload({ lastOnlineAt: null });
    const profiles = makeProfiles({
      getAnonymousProfile: jest.fn(async () => ({ payload, cache: 'miss' })),
    });
    const controller = new PublicController(makePosts(), profiles);

    const result = await controller.getProfile('alice', makeRes());

    expect(result.data).toEqual(expect.objectContaining({ lastOnlineAt: null }));
  });

  it('has birthdayMonthDay: null when service redacts it (birthdayVisibility: none)', async () => {
    const payload = makeProfilePayload({ birthdayDisplay: null, birthdayMonthDay: null });
    const profiles = makeProfiles({
      getAnonymousProfile: jest.fn(async () => ({ payload, cache: 'miss' })),
    });
    const controller = new PublicController(makePosts(), profiles);

    const result = await controller.getProfile('alice', makeRes());

    expect(result.data).toEqual(expect.objectContaining({ birthdayDisplay: null, birthdayMonthDay: null }));
  });

  it('sets Cache-Control: public, max-age=300, stale-while-revalidate=600', async () => {
    const profiles = makeProfiles({
      getAnonymousProfile: jest.fn(async () => ({ payload: makeProfilePayload(), cache: 'miss' })),
    });
    const controller = new PublicController(makePosts(), profiles);
    const res = makeRes();

    await controller.getProfile('alice', res);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
  });

  it('propagates NotFoundException for unknown usernames', async () => {
    const profiles = makeProfiles({
      getAnonymousProfile: jest.fn(async () => {
        throw new NotFoundException('User not found');
      }),
    });
    const controller = new PublicController(makePosts(), profiles);

    await expect(controller.getProfile('nobody', makeRes())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns { data: { banned: true } } for banned users', async () => {
    const profiles = makeProfiles({
      getAnonymousProfile: jest.fn(async () => ({ payload: { banned: true }, cache: 'miss' })),
    });
    const controller = new PublicController(makePosts(), profiles);

    const result = await controller.getProfile('banned-user', makeRes());

    expect(result.data).toEqual({ banned: true });
  });
});
