import { AUTH_COOKIE_NAME } from './auth.constants';
import { AuthController } from './auth.controller';
import { CrewInvitesService } from '../crew/crew-invites.service';
import { MessagesService } from '../messages/messages.service';
import { NotificationsService } from '../notifications/notifications.service';

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
    const moduleRef = {
      get: jest.fn((token: unknown) => {
        if (token === NotificationsService) return notifications;
        if (token === MessagesService) return messages;
        if (token === CrewInvitesService) return crewInvites;
        return null;
      }),
    } as any;
    const controller = new AuthController(auth, {} as any, moduleRef);

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
    });
    expect(crewInvites.countInboxPending).toHaveBeenCalledWith('user-1');
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
    const controller = new AuthController(auth, {} as any, moduleRef);

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
    });
  });
});
