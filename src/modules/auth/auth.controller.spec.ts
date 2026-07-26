import { AUTH_COOKIE_NAME } from './auth.constants';
import { AuthController } from './auth.controller';
import { CrewInvitesService } from '../crew/crew-invites.service';
import { MessagesService } from '../messages/messages.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

describe('AuthController.me', () => {
  it('returns all home-load badge counts in the auth payload', async () => {
    const user = { id: 'user-1', username: 'tester', pinnedPostId: null };
    const auth = {
      meFromSessionToken: jest.fn(async () => ({
        user,
        renewed: false,
        expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      })),
      runMeChecks: jest.fn(async () => user),
      setSessionCookie: jest.fn(),
    } as any;
    const notifications = {
      getUndeliveredCount: jest.fn(async () => 5),
      getUnreadCommentCount: jest.fn(async () => 2),
      getGroupsUnread: jest.fn(async () => ({ total: 4, byGroupId: { 'group-1': 3, 'group-2': 1 } })),
    };
    const messages = { getUnreadSummary: jest.fn(async () => ({ primary: 6, requests: 1 })) };
    const crewInvites = { countInboxPending: jest.fn(async () => 3) };
    const prisma = {
      post: { count: jest.fn(async () => 978) },
      article: { count: jest.fn(async () => 12) },
    };
    const moduleRef = {
      get: jest.fn((token: unknown) => {
        if (token === NotificationsService) return notifications;
        if (token === MessagesService) return messages;
        if (token === CrewInvitesService) return crewInvites;
        if (token === PrismaService) return prisma;
        return null;
      }),
    } as any;
    const controller = new AuthController(auth, {} as any, moduleRef, {} as any, {
      describe: jest.fn(async () => null),
    } as any);

    const result = await controller.me(
      { cookies: { [AUTH_COOKIE_NAME]: 'session-token' } } as any,
      { cookie: jest.fn() } as any,
    );

    expect(result.data).toEqual({
      ...user,
      notificationUndeliveredCount: 5,
      notificationUnreadCommentCount: 2,
      groupsUnread: { total: 4, byGroupId: { 'group-1': 3, 'group-2': 1 } },
      crewInviteInboxCount: 3,
      messageUnreadCounts: { primary: 6, requests: 1 },
      postCount: 978,
      articleCount: 12,
      impersonation: null,
    });
    expect(crewInvites.countInboxPending).toHaveBeenCalledWith('user-1');
    expect(prisma.post.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', deletedAt: null, isDraft: false },
    });
    expect(prisma.article.count).toHaveBeenCalledWith({
      where: {
        authorId: 'user-1',
        deletedAt: null,
        isDraft: false,
        publishedAt: { not: null },
      },
    });
  });

  it('falls back to zero values when optional home-load count lookups fail', async () => {
    const user = { id: 'user-1', pinnedPostId: null };
    const auth = {
      meFromSessionToken: jest.fn(async () => ({
        user,
        renewed: false,
        expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      })),
      runMeChecks: jest.fn(async () => user),
    } as any;
    const notifications = {
      getUndeliveredCount: jest.fn(async () => {
        throw new Error('unavailable');
      }),
      getUnreadCommentCount: jest.fn(async () => {
        throw new Error('unavailable');
      }),
      getGroupsUnread: jest.fn(async () => {
        throw new Error('unavailable');
      }),
    };
    const moduleRef = {
      get: jest.fn((token: unknown) => {
        if (token === NotificationsService) return notifications;
        if (token === MessagesService) return null;
        if (token === CrewInvitesService) throw new Error('module absent');
        return null;
      }),
    } as any;
    const controller = new AuthController(auth, {} as any, moduleRef, {} as any, {
      describe: jest.fn(async () => null),
    } as any);

    const result = await controller.me(
      { cookies: { [AUTH_COOKIE_NAME]: 'session-token' } } as any,
      {} as any,
    );

    expect(result.data).toEqual({
      ...user,
      notificationUndeliveredCount: 0,
      notificationUnreadCommentCount: 0,
      groupsUnread: { total: 0, byGroupId: {} },
      crewInviteInboxCount: 0,
      messageUnreadCounts: { primary: 0, requests: 0 },
      postCount: null,
      articleCount: null,
      impersonation: null,
    });
  });

  it('surfaces the impersonating admin when the session is an impersonation session', async () => {
    const user = { id: 'target-1', username: 'target', pinnedPostId: null };
    const auth = {
      meFromSessionToken: jest.fn(async () => ({
        user,
        renewed: false,
        expiresAt: new Date('2026-08-01T00:00:00.000Z'),
        impersonatedByUserId: 'admin-1',
      })),
      runMeChecks: jest.fn(async () => user),
    } as any;
    const impersonation = {
      describe: jest.fn(async () => ({
        adminUserId: 'admin-1',
        adminUsername: 'boss',
        adminName: 'The Boss',
        adminAvatarUrl: null,
      })),
    } as any;
    const moduleRef = { get: jest.fn(() => null) } as any;
    const controller = new AuthController(auth, {} as any, moduleRef, {} as any, impersonation);

    const result = await controller.me(
      { cookies: { [AUTH_COOKIE_NAME]: 'session-token' } } as any,
      {} as any,
    );

    expect(impersonation.describe).toHaveBeenCalledWith('admin-1');
    expect(result.data?.impersonation).toEqual({
      adminUserId: 'admin-1',
      adminUsername: 'boss',
      adminName: 'The Boss',
      adminAvatarUrl: null,
    });
  });
});

describe('AuthController browser handoff', () => {
  function makeController() {
    const browserHandoff = {
      mint: jest.fn(async () => ({
        handoffUrl: 'https://api.menofhunger.com/v1/auth/browser-handoff/redeem?code=secret',
        expiresAt: '2026-07-13T18:01:30.000Z',
      })),
      redeem: jest.fn(
        async (): Promise<{ destinationUrl: string } | null> => ({
          destinationUrl: 'https://menofhunger.com/settings',
        }),
      ),
      invalidRedirectUrl: jest.fn(
        () => 'https://menofhunger.com/login?handoffError=invalid_or_expired',
      ),
    };
    const controller = new AuthController(
      {} as any,
      {} as any,
      {} as any,
      browserHandoff as any,
      {} as any,
    );
    return { controller, browserHandoff };
  }

  it('requires an authenticated user when minting', async () => {
    const { controller, browserHandoff } = makeController();
    await expect(
      controller.createBrowserHandoff({} as any, { destination: '/settings' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(browserHandoff.mint).not.toHaveBeenCalled();
  });

  it('returns the explicit data envelope for an authenticated mint', async () => {
    const { controller, browserHandoff } = makeController();
    const result = await controller.createBrowserHandoff(
      { user: { id: 'user-1' } } as any,
      { destination: '/settings?from=ios' },
    );

    expect(browserHandoff.mint).toHaveBeenCalledWith('user-1', '/settings?from=ios');
    expect(result).toEqual({
      data: {
        handoffUrl: 'https://api.menofhunger.com/v1/auth/browser-handoff/redeem?code=secret',
        expiresAt: '2026-07-13T18:01:30.000Z',
      },
    });
  });

  it('redirects successful redemption to the service-approved site URL', async () => {
    const { controller } = makeController();
    const response = { redirect: jest.fn() } as any;
    await controller.redeemBrowserHandoff({ code: 'valid-code' }, response);
    expect(response.redirect).toHaveBeenCalledWith(302, 'https://menofhunger.com/settings');
  });

  it('redirects malformed or invalid redemption to login without a JSON error page', async () => {
    const { controller, browserHandoff } = makeController();
    const malformedResponse = { redirect: jest.fn() } as any;
    const invalidResponse = { redirect: jest.fn() } as any;

    await controller.redeemBrowserHandoff({}, malformedResponse);
    browserHandoff.redeem.mockResolvedValueOnce(null);
    await controller.redeemBrowserHandoff({ code: 'missing-code' }, invalidResponse);

    const loginUrl = 'https://menofhunger.com/login?handoffError=invalid_or_expired';
    expect(malformedResponse.redirect).toHaveBeenCalledWith(302, loginUrl);
    expect(invalidResponse.redirect).toHaveBeenCalledWith(302, loginUrl);
  });
});
