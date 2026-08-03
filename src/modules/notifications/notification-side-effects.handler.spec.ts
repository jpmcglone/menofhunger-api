/**
 * Unit tests for NotificationSideEffectsHandler.
 *
 * These cover the two effects that only exist because of the queue: the retryable push send
 * and one chunk of a split fan-out.
 */
import { NotificationSideEffectsHandler } from './notification-side-effects.handler';

function build() {
  const push = { sendKindPushForActor: jest.fn(async () => undefined) };
  const writer = { create: jest.fn(async () => undefined) };
  const registry = { register: jest.fn() };
  const handler = new NotificationSideEffectsHandler(push as any, writer as any, registry as any);
  return { handler, push, writer, registry };
}

describe('NotificationSideEffectsHandler registration', () => {
  it('registers both notification effects on init', () => {
    const { handler, registry } = build();
    handler.onModuleInit();

    const names = registry.register.mock.calls.map(([name]) => name);
    expect(names).toEqual(expect.arrayContaining(['notification.push', 'notification.fanout.chunk']));
  });
});

describe('notification.push', () => {
  it('forwards the payload to the push service verbatim', async () => {
    const { handler, push } = build();
    const payload = {
      recipientUserId: 'r1',
      kind: 'comment' as const,
      actorUserId: 'a1',
      fallbackTitle: 'replied to you',
      body: 'hello',
      url: '/p/post-1',
      notificationId: 'notif-1',
    };

    await handler['onPush'](payload);

    expect(push.sendKindPushForActor).toHaveBeenCalledWith(payload);
  });

  it('skips a payload with no recipient rather than throwing a retry loop', async () => {
    const { handler, push } = build();

    await handler['onPush']({ recipientUserId: '', kind: 'comment' as const, actorUserId: 'a1' });

    expect(push.sendKindPushForActor).not.toHaveBeenCalled();
  });

  /**
   * The processor treats a thrown error as a retry signal, so a transient APNs failure must
   * propagate rather than be swallowed here.
   */
  it('lets a push failure propagate so BullMQ retries it', async () => {
    const { handler, push } = build();
    push.sendKindPushForActor.mockRejectedValueOnce(new Error('apns 503'));

    await expect(
      handler['onPush']({ recipientUserId: 'r1', kind: 'comment' as const, actorUserId: 'a1' }),
    ).rejects.toThrow('apns 503');
  });
});

describe('notification.fanout.chunk', () => {
  const chunkPayload = (recipientUserIds: string[]) => ({
    kind: 'followed_post' as const,
    recipientUserIds,
    actorUserId: 'a1',
    actorPostId: 'post-1',
    subjectPostId: 'post-1',
    subjectUserId: null,
    subjectArticleId: null,
    subjectGroupId: null,
    title: 'posted',
    body: 'body text',
  });

  it('writes one notification per recipient', async () => {
    const { handler, writer } = build();

    await handler['onFanoutChunk'](chunkPayload(['r1', 'r2', 'r3']));

    expect(writer.create).toHaveBeenCalledTimes(3);
    expect(writer.create).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: 'r2', kind: 'followed_post', subjectPostId: 'post-1' }),
    );
  });

  /**
   * A chunk is a batch of independent recipients. One bad row (deleted user, unique-constraint
   * race) must not cost the other 199 their notification, so failures are counted, not thrown.
   */
  it('keeps going when one recipient write fails', async () => {
    const { handler, writer } = build();
    writer.create
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('recipient vanished'))
      .mockResolvedValueOnce(undefined);

    await expect(handler['onFanoutChunk'](chunkPayload(['r1', 'r2', 'r3']))).resolves.toBeUndefined();

    expect(writer.create).toHaveBeenCalledTimes(3);
  });

  it('does nothing for an empty recipient list', async () => {
    const { handler, writer } = build();

    await handler['onFanoutChunk'](chunkPayload([]));

    expect(writer.create).not.toHaveBeenCalled();
  });
});
