import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PostsDraftsService } from './posts-drafts.service';
import { PostsMutationService } from './posts-mutation.service';
import { PostsRankingService } from './posts-ranking.service';
import { PostsViewerEnrichmentService } from './posts-viewer-enrichment.service';
import { notDeletedWhere, excludeCommunityGroupPostsWhere, mediaOnlyWhere, userNotBannedWhere } from './posts-query-builders';

describe('posts-query-builders', () => {
  it('builds the shared post where-clauses', () => {
    expect(notDeletedWhere()).toEqual({ deletedAt: null });
    expect(excludeCommunityGroupPostsWhere()).toEqual({ communityGroupId: null });
    expect(mediaOnlyWhere()).toEqual({ media: { some: { deletedAt: null } } });
    expect(userNotBannedWhere()).toEqual({ user: { bannedAt: null } });
  });
});

describe('PostsRankingService', () => {
  it('enqueueScoreRefresh enqueues a deduplicated job keyed by post id', () => {
    const jobs = { enqueue: jest.fn(async () => undefined) };
    const service = new PostsRankingService({} as any, jobs as any);

    service.enqueueScoreRefresh('p1');

    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.any(String),
      { postId: 'p1' },
      expect.objectContaining({ jobId: 'score-p1' }),
    );
  });

  it('enqueueScoreRefresh is a no-op without a post id', () => {
    const jobs = { enqueue: jest.fn(async () => undefined) };
    const service = new PostsRankingService({} as any, jobs as any);

    service.enqueueScoreRefresh('');

    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('ensureBoostScoresFresh returns an empty map for no ids', async () => {
    const prisma = { post: { findMany: jest.fn() } };
    const service = new PostsRankingService(prisma as any, { enqueue: jest.fn() } as any);

    const out = await service.ensureBoostScoresFresh([]);

    expect(out.size).toBe(0);
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });
});

describe('PostsDraftsService.createDraft — media/character-limit gates', () => {
  const verifiedUser = { verifiedStatus: 'identity', premium: false, premiumPlus: false };
  const unverifiedUser = { verifiedStatus: 'none', premium: false, premiumPlus: false };
  const premiumUser = { verifiedStatus: 'identity', premium: true, premiumPlus: false };

  const stubPost = (user: typeof verifiedUser) => ({
    id: 'draft-1',
    body: '',
    visibility: 'onlyMe',
    isDraft: true,
    userId: 'u1',
    media: [],
    mentions: [],
    user,
    createdAt: new Date(),
    updatedAt: new Date(),
    topics: [],
    hashtags: [],
    hashtagCasings: [],
  });

  function makeService(user: typeof verifiedUser) {
    const prisma: any = {
      post: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => stubPost(user)),
      },
      user: { findUnique: jest.fn(async () => ({ ...user, id: 'u1' })) },
      // cleanMediaItems calls this to detect reused content-hash keys.
      mediaContentHash: { findMany: jest.fn(async () => []) },
    };
    return { service: new PostsDraftsService(prisma) };
  }

  const image = { source: 'upload' as const, kind: 'image' as const, r2Key: 'uploads/u1/images/x.jpg' };
  const gif = { source: 'giphy' as const, kind: 'gif' as const, url: 'https://media.giphy.com/x.gif' };
  const video = { source: 'upload' as const, kind: 'video' as const, r2Key: 'uploads/u1/videos/x.mp4' };

  it('allows verified user to create a draft with an image', async () => {
    const { service } = makeService(verifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'hello', media: [image] })).resolves.toBeDefined();
  });

  it('allows verified user to create a draft with a GIF', async () => {
    const { service } = makeService(verifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'hello', media: [gif] })).resolves.toBeDefined();
  });

  it('blocks unverified user from creating a draft with an image', async () => {
    const { service } = makeService(unverifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'hello', media: [image] })).rejects.toThrow(
      new ForbiddenException('Verify your account to post images and GIFs.'),
    );
  });

  it('blocks verified (non-premium) user from creating a draft with video', async () => {
    const { service } = makeService(verifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'hello', media: [video] })).rejects.toThrow(
      new ForbiddenException('Video posts are for premium members only.'),
    );
  });

  it('allows premium user to create a draft with video', async () => {
    const { service } = makeService(premiumUser);
    await expect(service.createDraft({ userId: 'u1', body: 'hello', media: [video] })).resolves.toBeDefined();
  });

  it('enforces 500-char body limit for verified (non-premium) users', async () => {
    const { service } = makeService(verifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'x'.repeat(501), media: null })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('allows 500-char body for verified (non-premium) users', async () => {
    const { service } = makeService(verifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'x'.repeat(500), media: null })).resolves.toBeDefined();
  });

  it('enforces 500-char body limit for unverified users', async () => {
    const { service } = makeService(unverifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'x'.repeat(501), media: null })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('allows 500-char body for unverified users', async () => {
    const { service } = makeService(unverifiedUser);
    await expect(service.createDraft({ userId: 'u1', body: 'x'.repeat(500), media: null })).resolves.toBeDefined();
  });

  it('allows 1000-char body for premium users', async () => {
    const { service } = makeService(premiumUser);
    await expect(service.createDraft({ userId: 'u1', body: 'x'.repeat(1000), media: null })).resolves.toBeDefined();
  });

  it('blocks premium user from 1001-char body', async () => {
    const { service } = makeService(premiumUser);
    await expect(service.createDraft({ userId: 'u1', body: 'x'.repeat(1001), media: null })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('PostsDraftsService.deleteDraft', () => {
  function makeService(postRow: unknown) {
    const prisma: any = {
      post: {
        findUnique: jest.fn(async () => postRow),
        update: jest.fn(async () => ({})),
      },
    };
    return { service: new PostsDraftsService(prisma), prisma };
  }

  it('throws NotFound when the draft does not exist', async () => {
    const { service } = makeService(null);
    await expect(service.deleteDraft({ userId: 'u1', draftId: 'd1' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws Forbidden when the draft belongs to another user', async () => {
    const { service } = makeService({ id: 'd1', userId: 'other', deletedAt: null, visibility: 'onlyMe', isDraft: true });
    await expect(service.deleteDraft({ userId: 'u1', draftId: 'd1' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws Forbidden when the post is not a draft', async () => {
    const { service } = makeService({ id: 'd1', userId: 'u1', deletedAt: null, visibility: 'public', isDraft: false });
    await expect(service.deleteDraft({ userId: 'u1', draftId: 'd1' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('soft-deletes the draft', async () => {
    const { service, prisma } = makeService({ id: 'd1', userId: 'u1', deletedAt: null, visibility: 'onlyMe', isDraft: true });
    const res = await service.deleteDraft({ userId: 'u1', draftId: 'd1' });
    expect(res).toEqual({ success: true });
    expect(prisma.post.update).toHaveBeenCalledWith({ where: { id: 'd1' }, data: { deletedAt: expect.any(Date) } });
  });

  it('is idempotent for already-deleted drafts', async () => {
    const { service, prisma } = makeService({ id: 'd1', userId: 'u1', deletedAt: new Date(), visibility: 'onlyMe', isDraft: true });
    const res = await service.deleteDraft({ userId: 'u1', draftId: 'd1' });
    expect(res).toEqual({ success: true });
    expect(prisma.post.update).not.toHaveBeenCalled();
  });
});

// ─── PostsMutationService.visibilityRank ─────────────────────────────────────

describe('PostsMutationService visibilityRank ordering', () => {
  it('ranks public < verifiedOnly < premiumOnly < onlyMe', () => {
    const svc = new PostsMutationService(
      {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any,
    );
    const rank = (vis: string) => (svc as any).visibilityRank(vis);
    expect(rank('public')).toBeLessThan(rank('verifiedOnly'));
    expect(rank('verifiedOnly')).toBeLessThan(rank('premiumOnly'));
    expect(rank('premiumOnly')).toBeLessThan(rank('onlyMe'));
  });
});

// ─── PostsMutationService.createPost — quote floor enforcement ────────────────

describe('PostsMutationService.createPost quote floor enforcement', () => {
  const SITE_URL = 'https://menofhunger.com';
  const QUOTED_POST_ID = 'quoted-post-id';
  const QUOTED_POST_URL = `${SITE_URL}/p/${QUOTED_POST_ID}`;
  const verifiedUser = { id: 'u1', verifiedStatus: 'identity', premium: false, premiumPlus: false, siteAdmin: false, bannedAt: null };
  const premiumUser = { id: 'u1', verifiedStatus: 'identity', premium: true, premiumPlus: false, siteAdmin: false, bannedAt: null };

  function makeQuoteFloorService(quotedVisibility: string, actor = verifiedUser) {
    const txPost: any = {
      findFirst: jest.fn(async (args: any) => {
        if (args?.where?.id === QUOTED_POST_ID) {
          return { id: QUOTED_POST_ID, userId: 'quoted-author', visibility: quotedVisibility };
        }
        return null;
      }),
      create: jest.fn(async () => ({ id: 'new-post', user: actor, media: [], mentions: [], hashtags: [], cashtags: [], hashtagCasings: [], topics: [] })),
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 0 })),
      count: jest.fn(async () => 0),
    };
    const prisma: any = {
      $transaction: jest.fn(async (fn: any) => {
        if (typeof fn === 'function') {
          return fn({
            post: txPost,
            user: { update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })), findUnique: jest.fn(async () => null) },
            mention: { create: jest.fn(async () => ({})) },
            postMention: { createMany: jest.fn(async () => ({ count: 0 })) },
            hashtag: { upsert: jest.fn(async () => ({})), update: jest.fn(), deleteMany: jest.fn(async () => ({ count: 0 })) },
            hashtagVariant: { upsert: jest.fn(async () => ({})), update: jest.fn(), deleteMany: jest.fn(async () => ({ count: 0 })) },
            cashtag: { upsert: jest.fn(async () => ({})) },
            coinTransfer: { create: jest.fn(async () => ({})) },
            communityGroupMember: { findUnique: jest.fn(async () => null) },
            $executeRaw: jest.fn(async () => 0),
          });
        }
        return Promise.all(fn);
      }),
      siteConfig: {
        findUnique: jest.fn(async () => ({
          id: 1, postsPerWindow: 100, windowSeconds: 60,
          verifiedPostsPerWindow: 100, verifiedWindowSeconds: 60,
          premiumPostsPerWindow: 100, premiumWindowSeconds: 60,
        })),
      },
      post: {
        findFirst: jest.fn(async () => null),
        count: jest.fn(async () => 0),
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(async () => []),
        update: jest.fn(),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      userBlock: { count: jest.fn(async () => 0) },
      mediaContentHash: { findMany: jest.fn(async () => []) },
    };
    const viewerContext: any = {
      getViewer: jest.fn(async () => actor),
      assertNotBanned: jest.fn(),
      isVerified: (v: any) => Boolean(v?.verifiedStatus && v.verifiedStatus !== 'none'),
      isPremium: (v: any) => Boolean(v?.premium || v?.premiumPlus),
      allowedPostVisibilities: (v: any) => {
        const list: string[] = ['public'];
        if (v?.verifiedStatus && v.verifiedStatus !== 'none') list.push('verifiedOnly');
        if (v?.premium || v?.premiumPlus) list.push('premiumOnly');
        return list;
      },
    };
    const enrichment = new PostsViewerEnrichmentService(
      prisma, {} as any, viewerContext, {} as any,
    );
    const ranking = new PostsRankingService(prisma, { enqueue: jest.fn(async () => undefined) } as any);
    const svc = new PostsMutationService(
      prisma,
      { deleteBySubjectPostId: jest.fn(), deleteByActorPostId: jest.fn(), create: jest.fn(), upsertRepostNotification: jest.fn() } as any,
      { emitFeedNewPost: jest.fn(), emitPostsLiveUpdated: jest.fn(), emitPostsInteraction: jest.fn(), emitPostsCommentDeleted: jest.fn() } as any,
      { bumpForPostWrite: jest.fn(async () => undefined) } as any,
      { r2: jest.fn(() => null), get: jest.fn(), frontendBaseUrl: jest.fn(() => null) } as any,
      {} as any,
      { enqueue: jest.fn(async () => undefined) } as any,
      { capture: jest.fn() } as any,
      { isBotUserId: jest.fn(() => false) } as any,
      viewerContext,
      enrichment,
      ranking,
      { isValid: () => false } as any,
    );
    return { svc, QUOTED_POST_URL };
  }

  it('blocks a quote of verifiedOnly post with public visibility', async () => {
    const { svc, QUOTED_POST_URL } = makeQuoteFloorService('verifiedOnly');
    await expect(
      svc.createPost({
        userId: 'u1',
        body: `My thoughts\n\n${QUOTED_POST_URL}`,
        visibility: 'public',
        media: null,
        poll: null,
      }),
    ).rejects.toThrow(new ForbiddenException("A quote can't be more public than the post it quotes."));
  });

  async function expectFloorNotViolated(svc: PostsMutationService, params: Parameters<PostsMutationService['createPost']>[0]) {
    let caught: unknown;
    try {
      await svc.createPost(params);
    } catch (err) {
      caught = err;
    }
    if (caught instanceof ForbiddenException) {
      expect(caught.message).not.toBe("A quote can't be more public than the post it quotes.");
    }
  }

  it('allows a quote of verifiedOnly post with verifiedOnly visibility', async () => {
    const { svc, QUOTED_POST_URL } = makeQuoteFloorService('verifiedOnly');
    await expectFloorNotViolated(svc, {
      userId: 'u1',
      body: `My thoughts\n\n${QUOTED_POST_URL}`,
      visibility: 'verifiedOnly',
      media: null,
      poll: null,
    });
  });

  it('allows a quote of verifiedOnly post with premiumOnly visibility', async () => {
    const { svc, QUOTED_POST_URL } = makeQuoteFloorService('verifiedOnly', premiumUser);
    await expectFloorNotViolated(svc, {
      userId: 'u1',
      body: `My thoughts\n\n${QUOTED_POST_URL}`,
      visibility: 'premiumOnly',
      media: null,
      poll: null,
    });
  });

  it('allows a quote of public post with public visibility', async () => {
    const { svc, QUOTED_POST_URL } = makeQuoteFloorService('public');
    await expectFloorNotViolated(svc, {
      userId: 'u1',
      body: `My thoughts\n\n${QUOTED_POST_URL}`,
      visibility: 'public',
      media: null,
      poll: null,
    });
  });

  it('does not enforce the floor for group posts (group forces public anyway)', async () => {
    const { svc, QUOTED_POST_URL } = makeQuoteFloorService('verifiedOnly');
    // group post passes the community group membership check (but we have no group mock)
    // — the floor check is skipped so error (if any) is about group membership, not the floor
    await expect(
      svc.createPost({
        userId: 'u1',
        body: `My thoughts\n\n${QUOTED_POST_URL}`,
        visibility: 'public',
        communityGroupId: 'g1',
        media: null,
        poll: null,
      }),
    ).rejects.not.toThrow(new ForbiddenException("A quote can't be more public than the post it quotes."));
  });
});
