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

function makeService(opts?: { configured?: boolean; tokens?: Array<{ id: string; token: string; environment: string }> }) {
  const configured = opts?.configured ?? true;
  const prisma = {
    apnsDeviceToken: {
      upsert: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 1 })),
      count: jest.fn(async () => (opts?.tokens?.length ?? 0)),
      findMany: jest.fn(async () => opts?.tokens ?? []),
    },
    notification: {
      count: jest.fn(async () => 3),
    },
  };
  const appConfig = {
    apns: jest.fn(() => (configured ? apnsConfig : null)),
    apnsConfigured: jest.fn(() => configured),
  };
  const svc = new ApnsPushService(prisma as any, appConfig as any);
  return { svc, prisma, appConfig };
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

  it('sendToUser sends one notification per device token with badge = undelivered count', async () => {
    const { svc } = makeService({
      tokens: [
        { id: 't1', token: 'tok-1', environment: 'production' },
        { id: 't2', token: 'tok-2', environment: 'sandbox' },
      ],
    });
    await svc.sendToUser('user-1', { title: 'New reply', body: 'Someone replied', url: '/p/abc', kind: 'comment' });
    expect(sendMock).toHaveBeenCalledTimes(2);
    const first = sendMock.mock.calls[0][0];
    expect(first.deviceToken).toBe('tok-1');
    expect(first.options.alert).toEqual({ title: 'New reply', body: 'Someone replied' });
    expect(first.options.badge).toBe(3);
    expect(first.options.data).toEqual(expect.objectContaining({ url: '/p/abc', kind: 'comment' }));
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

  it('sendDiagnosticToUser returns success result per token when APNs accepts', async () => {
    const { svc } = makeService({
      tokens: [
        { id: 't1', token: 'abc1234500000001', environment: 'production' },
        { id: 't2', token: 'abc1234500000002', environment: 'sandbox' },
      ],
    });
    const results = await svc.sendDiagnosticToUser('user-1', { title: 'Test', body: 'Works', url: '/notifications' });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ token: '00000001', environment: 'production', success: true });
    expect(results[1]).toEqual({ token: '00000002', environment: 'sandbox', success: true });
  });

  it('sendDiagnosticToUser surfaces the APNs error reason instead of swallowing it', async () => {
    const { svc, prisma } = makeService({
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
