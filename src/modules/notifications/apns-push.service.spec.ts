import { ApnsPushService } from './apns-push.service';

const sendMock = jest.fn();

jest.mock('apns2', () => {
  class ApnsError extends Error {
    statusCode: number;
    notification: unknown;
    response: { reason: string; timestamp: number };
    constructor(props: { statusCode: number; notification: unknown; response: { reason: string; timestamp: number } }) {
      super(`apns error: ${props.response.reason}`);
      this.statusCode = props.statusCode;
      this.notification = props.notification;
      this.response = props.response;
    }
    get reason() {
      return this.response.reason;
    }
  }
  class ApnsClient {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
    send(notification: unknown) {
      return sendMock(notification);
    }
  }
  class Notification {
    deviceToken: string;
    options: unknown;
    constructor(deviceToken: string, options: unknown) {
      this.deviceToken = deviceToken;
      this.options = options;
    }
  }
  return {
    ApnsClient,
    ApnsError,
    Notification,
    Host: { production: 'api.push.apple.com', development: 'api.sandbox.push.apple.com' },
  };
});

// Re-import the mocked error class for constructing test failures.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ApnsError: MockApnsError } = require('apns2');

const apnsConfig = {
  keyId: 'KEY123',
  teamId: 'TEAM123',
  privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
  bundleId: 'com.menofhunger.app',
};

function makeCache() {
  const store = new Map<string, unknown>();
  return {
    store,
    getOrSetJson: jest.fn(async ({ key, compute }: { key: string; compute: () => Promise<unknown> }) => {
      if (store.has(key)) return store.get(key);
      const v = await compute();
      store.set(key, v);
      return v;
    }),
    setJson: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    del: jest.fn(async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
    }),
  };
}

function makeService(opts?: { configured?: boolean; tokens?: Array<{ id: string; token: string; environment: string }> }) {
  const configured = opts?.configured ?? true;
  const prisma = {
    apnsDeviceToken: {
      upsert: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 1 })),
      count: jest.fn(async () => (opts?.tokens?.length ?? 0)),
      findMany: jest.fn(async () => opts?.tokens ?? []),
      findUnique: jest.fn(),
    },
    notification: {
      count: jest.fn(async () => 3),
    },
    user: {
      findUnique: jest.fn(async () => ({ undeliveredNotificationCount: 0 })),
    },
  };
  const appConfig = {
    apns: jest.fn(() => (configured ? apnsConfig : null)),
    apnsConfigured: jest.fn(() => configured),
  };
  const cache = makeCache();
  const svc = new ApnsPushService(prisma as any, appConfig as any, cache as any);
  return { svc, prisma, appConfig, cache };
}

describe('ApnsPushService', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  it('registerToken upserts by token and rebinds to the current user', async () => {
    const { svc, prisma } = makeService();
    await svc.registerToken('user-1', { token: ' abc123 ', environment: 'sandbox' });
    expect(prisma.apnsDeviceToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { token: 'abc123' },
        create: expect.objectContaining({ userId: 'user-1', token: 'abc123', environment: 'sandbox' }),
        update: expect.objectContaining({ userId: 'user-1', environment: 'sandbox' }),
      }),
    );
  });

  it('registerToken defaults unknown environments to production', async () => {
    const { svc, prisma } = makeService();
    await svc.registerToken('user-1', { token: 'abc123', environment: 'weird' });
    expect(prisma.apnsDeviceToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ environment: 'production' }),
      }),
    );
  });

  it('unregisterToken only deletes the calling user’s binding', async () => {
    const { svc, prisma } = makeService();
    await svc.unregisterToken('user-1', 'abc123');
    expect(prisma.apnsDeviceToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', token: 'abc123' },
    });
  });

  it('sendToUser is a no-op when APNs is not configured', async () => {
    const { svc, prisma } = makeService({ configured: false, tokens: [{ id: 't1', token: 'tok', environment: 'production' }] });
    await svc.sendToUser('user-1', { title: 'Hello' });
    expect(prisma.apnsDeviceToken.findMany).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sendToUser sends one notification per device token with badge = bell + groups', async () => {
    const { svc, prisma } = makeService({
      tokens: [
        { id: 't1', token: 'tok-1', environment: 'production' },
        { id: 't2', token: 'tok-2', environment: 'sandbox' },
      ],
    });
    prisma.user.findUnique.mockResolvedValue({ undeliveredNotificationCount: 2 });
    prisma.notification.count.mockResolvedValue(1);
    await svc.sendToUser('user-1', { title: 'New reply', body: 'Someone replied', url: '/p/abc', kind: 'comment' });
    expect(sendMock).toHaveBeenCalledTimes(2);
    const first = sendMock.mock.calls[0][0];
    expect(first.deviceToken).toBe('tok-1');
    expect(first.options.alert).toEqual({ title: 'New reply', body: 'Someone replied' });
    expect(first.options.badge).toBe(3);
    expect(first.options.data).toEqual(expect.objectContaining({ url: '/p/abc', kind: 'comment' }));
  });

  it('sendToUser includes rich alert metadata and custom navigation fields', async () => {
    const { svc } = makeService({
      tokens: [{ id: 't1', token: 'tok-1', environment: 'production' }],
    });
    await svc.sendToUser('user-1', {
      title: 'Alice replied to your post',
      subtitle: 'Reply to your post',
      body: 'Great post!',
      kind: 'comment',
      mutableContent: true,
      threadId: 'post-root-1',
      category: 'moh.category.reply',
      avatarUrl: 'https://cdn.example.com/alice.jpg',
      mediaUrl: 'https://cdn.example.com/reply.jpg',
      actorUsername: 'alice',
      actorName: 'Alice',
      groupInviteId: 'invite-1',
      postId: 'parent-post-1',
    });

    const notification = sendMock.mock.calls[0][0];
    expect(notification.options).toEqual(
      expect.objectContaining({
        alert: {
          title: 'Alice replied to your post',
          subtitle: 'Reply to your post',
          body: 'Great post!',
        },
        mutableContent: true,
        threadId: 'post-root-1',
        category: 'moh.category.reply',
        data: expect.objectContaining({
          avatarUrl: 'https://cdn.example.com/alice.jpg',
          mediaUrl: 'https://cdn.example.com/reply.jpg',
          actorUsername: 'alice',
          actorName: 'Alice',
          groupInviteId: 'invite-1',
          postId: 'parent-post-1',
        }),
      }),
    );
  });

  it('sendToUser prunes dead tokens on 410/BadDeviceToken and keeps the rest', async () => {
    const { svc, prisma } = makeService({
      tokens: [
        { id: 't1', token: 'tok-dead', environment: 'production' },
        { id: 't2', token: 'tok-alive', environment: 'production' },
      ],
    });
    sendMock.mockImplementation((notification: { deviceToken: string }) => {
      if (notification.deviceToken === 'tok-dead') {
        return Promise.reject(
          new MockApnsError({
            statusCode: 410,
            notification,
            response: { reason: 'Unregistered', timestamp: Date.now() },
          }),
        );
      }
      return Promise.resolve({});
    });
    await svc.sendToUser('user-1', { title: 'Hello' });
    expect(prisma.apnsDeviceToken.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['t1'] } } });
  });

  it('sendToUser swallows transient send errors without pruning', async () => {
    const { svc, prisma } = makeService({
      tokens: [{ id: 't1', token: 'tok-1', environment: 'production' }],
    });
    sendMock.mockRejectedValue(new Error('network blip'));
    await expect(svc.sendToUser('user-1', { title: 'Hello' })).resolves.toBeUndefined();
    expect(prisma.apnsDeviceToken.deleteMany).not.toHaveBeenCalled();
  });

  it('sendDiagnosticToUser sends a rich, platform-labeled preview and returns per-token success', async () => {
    const { svc } = makeService({
      tokens: [
        { id: 't1', token: 'abc1234500000001', environment: 'production' },
        { id: 't2', token: 'abc1234500000002', environment: 'sandbox' },
      ],
    });
    const results = await svc.sendDiagnosticToUser('user-1', {
      title: 'Test iOS push',
      subtitle: 'Rich notification preview',
      body: 'iOS APNs is working.',
      url: '/notifications',
      avatarUrl: 'https://cdn.example.com/avatar.jpg',
      mediaUrl: 'https://menofhunger.com/images/logo-black-bg-small.png',
      actorUsername: 'alice',
      actorName: 'Alice',
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ token: '00000001', environment: 'production', success: true });
    expect(results[1]).toEqual({ token: '00000002', environment: 'sandbox', success: true });
    expect(sendMock.mock.calls[0][0].options).toEqual(
      expect.objectContaining({
        alert: {
          title: 'Test iOS push',
          subtitle: 'Rich notification preview',
          body: 'iOS APNs is working.',
        },
        mutableContent: true,
        threadId: 'test-ios-push',
        data: expect.objectContaining({
          avatarUrl: 'https://cdn.example.com/avatar.jpg',
          mediaUrl: 'https://menofhunger.com/images/logo-black-bg-small.png',
          actorUsername: 'alice',
          actorName: 'Alice',
        }),
      }),
    );
  });

  it('sendDiagnosticToUser surfaces the APNs error reason instead of swallowing it', async () => {
    const { svc } = makeService({
      tokens: [{ id: 't1', token: 'tok-bad00000000', environment: 'production' }],
    });
    sendMock.mockRejectedValue(
      new MockApnsError({
        statusCode: 400,
        notification: {},
        response: { reason: 'BadDeviceToken', timestamp: Date.now() },
      }),
    );
    const results = await svc.sendDiagnosticToUser('user-1', { title: 'Test', body: 'Works', url: '/notifications' });
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/BadDeviceToken/);
  });

  it('sendDiagnosticToUser prunes dead tokens (410) and reports failure', async () => {
    const { svc, prisma } = makeService({
      tokens: [{ id: 't1', token: 'tok-dead00000000', environment: 'production' }],
    });
    sendMock.mockRejectedValue(
      new MockApnsError({
        statusCode: 410,
        notification: {},
        response: { reason: 'Unregistered', timestamp: Date.now() },
      }),
    );
    const results = await svc.sendDiagnosticToUser('user-1', { title: 'Test', body: 'Works', url: '/notifications' });
    expect(results[0].success).toBe(false);
    expect(prisma.apnsDeviceToken.deleteMany).toHaveBeenCalledWith({ where: { id: 't1' } });
  });

  it('sendDiagnosticToUser returns empty array when APNs is not configured', async () => {
    const { svc } = makeService({ configured: false });
    const results = await svc.sendDiagnosticToUser('user-1', { title: 'Test', body: 'Works', url: '/notifications' });
    expect(results).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('ApnsPushService — token cache', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  it('sendToUser reads tokens from DB on first call and from cache on the second', async () => {
    const { svc, prisma } = makeService({
      tokens: [{ id: 't1', token: 'tok-cached', environment: 'production' }],
    });
    await svc.sendToUser('user-1', { title: 'First' });
    await svc.sendToUser('user-1', { title: 'Second' });
    // Only one DB query for tokens across both sends.
    expect(prisma.apnsDeviceToken.findMany).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('unregisterToken invalidates the token cache', async () => {
    const { svc, cache } = makeService();
    await svc.unregisterToken('user-1', 'tok-abc');
    expect(cache.del).toHaveBeenCalledWith(expect.stringContaining('push:apns:tokens:user-1'));
  });

  it('registerToken invalidates the cache for the new user', async () => {
    const { svc, cache } = makeService();
    await svc.registerToken('user-1', { token: 'new-token', environment: 'production' });
    expect(cache.del).toHaveBeenCalledWith(expect.stringContaining('push:apns:tokens:user-1'));
  });

  it('registerToken also invalidates cache for the previous owner when a token is stolen', async () => {
    const { svc, prisma, cache } = makeService();
    prisma.apnsDeviceToken.findUnique.mockResolvedValue({ userId: 'user-old' });
    await svc.registerToken('user-new', { token: 'shared-token', environment: 'production' });
    const delCalls = cache.del.mock.calls.flat();
    expect(delCalls.some((k: string) => k.includes('user-new'))).toBe(true);
    expect(delCalls.some((k: string) => k.includes('user-old'))).toBe(true);
  });

  it('sendToUser invalidates cache when dead tokens are pruned', async () => {
    const { svc, prisma, cache } = makeService({
      tokens: [{ id: 't1', token: 'tok-dead', environment: 'production' }],
    });
    sendMock.mockRejectedValue(
      new MockApnsError({
        statusCode: 410,
        notification: {},
        response: { reason: 'Unregistered', timestamp: Date.now() },
      }),
    );
    await svc.sendToUser('user-1', { title: 'Hello' });
    expect(prisma.apnsDeviceToken.deleteMany).toHaveBeenCalled();
    expect(cache.del).toHaveBeenCalledWith(expect.stringContaining('push:apns:tokens:user-1'));
  });

  it('sendBadgeOnly sends badge without alert/sound and coalesces identical values', async () => {
    const { svc, prisma } = makeService({
      tokens: [{ id: 't1', token: 'tok-1', environment: 'production' }],
    });
    prisma.user.findUnique.mockResolvedValue({ undeliveredNotificationCount: 0 });
    prisma.notification.count.mockResolvedValue(0);
    await svc.sendBadgeOnly('user-1');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const first = sendMock.mock.calls[0][0];
    expect(first.options.badge).toBe(0);
    expect(first.options.alert).toBeUndefined();
    expect(first.options.sound).toBeUndefined();
    expect(first.options.collapseId).toBe('badge-sync');

    await svc.sendBadgeOnly('user-1', 0);
    expect(sendMock).toHaveBeenCalledTimes(1);

    await svc.sendBadgeOnly('user-1', 4);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1][0].options.badge).toBe(4);
  });

  it('computeAppIconBadge sums bell undelivered and group undelivered', async () => {
    const { svc, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ undeliveredNotificationCount: 5 });
    prisma.notification.count.mockResolvedValue(2);
    await expect(svc.computeAppIconBadge('user-1')).resolves.toBe(7);
  });
});
