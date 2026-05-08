import { MarvinCannedRepliesService } from './marvin-canned-replies.service';

type Reason = 'not_premium' | 'ai_not_configured';

function makeService(opts?: {
  marvUserId?: string | null;
  threadClaim?: (args: {
    userId: string;
    rootPostId: string;
    reason: Reason;
  }) => Promise<boolean>;
  postReturnsId?: string | null;
  messageReturnsId?: string | null;
}) {
  const appConfig: any = { frontendBaseUrl: () => 'https://example.test' };
  // Note: use explicit hasOwnProperty check rather than `??` so callers can pass
  // `marvUserId: null` to simulate "Marv user unresolved" — `null ?? 'marv-id'` would
  // wrongly fall through to the default.
  const marvUserId = opts && Object.prototype.hasOwnProperty.call(opts, 'marvUserId')
    ? opts.marvUserId ?? null
    : 'marv-id';
  const identity: any = {
    getMarvUserId: jest.fn(async () => marvUserId),
  };
  const posts: any = {
    createPost: jest.fn(async (args: any) => ({
      post: opts?.postReturnsId === undefined
        ? { id: 'p-canned' }
        : opts.postReturnsId
          ? { id: opts.postReturnsId }
          : null,
      _args: args,
    })),
  };
  const messages: any = {
    sendBotDirectMessage: jest.fn(async (args: any) => {
      const id = opts?.messageReturnsId === undefined ? 'm-canned' : opts.messageReturnsId;
      return id ? { conversationId: 'c1', message: { id }, _args: args } : null;
    }),
  };
  const nonPremium: any = {
    tryClaim: jest.fn(opts?.threadClaim ?? (async () => true)),
    setMarvPostId: jest.fn(async () => undefined),
  };
  const credits: any = {
    msUntilCredits: jest.fn(() => 1000 * 60 * 60),
  };
  // Static helper used in sendOutOfCreditsDm; only matters for that path.
  (MarvinCannedRepliesService as any).humanizeMs = (_n: number) => '1 hour';

  const svc = new MarvinCannedRepliesService(
    appConfig,
    identity,
    posts,
    messages,
    nonPremium,
    credits,
  );
  return { svc, posts, messages, nonPremium, identity };
}

describe('MarvinCannedRepliesService', () => {
  describe('sendNotConfiguredThreadReply', () => {
    it('claims (user, root, ai_not_configured) and posts a single thread reply', async () => {
      const { svc, nonPremium, posts } = makeService();
      const id = await svc.sendNotConfiguredThreadReply({
        requestingUserId: 'u1',
        triggeringPostId: 'p1',
        rootPostId: 'r1',
      });
      expect(id).toBe('p-canned');
      expect(nonPremium.tryClaim).toHaveBeenCalledWith({
        userId: 'u1',
        rootPostId: 'r1',
        reason: 'ai_not_configured',
      });
      expect(posts.createPost).toHaveBeenCalledTimes(1);
      const call = posts.createPost.mock.calls[0][0];
      expect(call.parentId).toBe('p1');
      expect(call.body).toMatch(/not fully set up yet/i);
      expect(nonPremium.setMarvPostId).toHaveBeenCalledWith({
        userId: 'u1',
        rootPostId: 'r1',
        reason: 'ai_not_configured',
        marvinPostId: 'p-canned',
      });
    });

    it('returns null and does not post when the slot was already claimed', async () => {
      const { svc, posts } = makeService({ threadClaim: async () => false });
      const id = await svc.sendNotConfiguredThreadReply({
        requestingUserId: 'u1',
        triggeringPostId: 'p1',
        rootPostId: 'r1',
      });
      expect(id).toBeNull();
      expect(posts.createPost).not.toHaveBeenCalled();
    });

    it('returns null when Marv user is unresolved', async () => {
      const { svc, posts } = makeService({ marvUserId: null });
      const id = await svc.sendNotConfiguredThreadReply({
        requestingUserId: 'u1',
        triggeringPostId: 'p1',
        rootPostId: 'r1',
      });
      expect(id).toBeNull();
      expect(posts.createPost).not.toHaveBeenCalled();
    });
  });

  describe('sendNotConfiguredDm', () => {
    it('sends a DM on every call (no per-conversation dedup)', async () => {
      const { svc, messages } = makeService();
      const first = await svc.sendNotConfiguredDm({ userId: 'u1', conversationId: 'c1' });
      const second = await svc.sendNotConfiguredDm({ userId: 'u1', conversationId: 'c1' });
      const third = await svc.sendNotConfiguredDm({ userId: 'u1', conversationId: 'c1' });
      expect(first.messageId).toBe('m-canned');
      expect(second.messageId).toBe('m-canned');
      expect(third.messageId).toBe('m-canned');
      expect(messages.sendBotDirectMessage).toHaveBeenCalledTimes(3);
      const call = messages.sendBotDirectMessage.mock.calls[0][0];
      expect(call.recipientUserId).toBe('u1');
      expect(call.body).toMatch(/not fully set up yet/i);
    });

    it('returns null and does not DM when Marv user is unresolved', async () => {
      const { svc, messages } = makeService({ marvUserId: null });
      const result = await svc.sendNotConfiguredDm({ userId: 'u1', conversationId: 'c1' });
      expect(result.messageId).toBeNull();
      expect(messages.sendBotDirectMessage).not.toHaveBeenCalled();
    });

    it('refuses to DM Marv himself', async () => {
      const { svc, messages } = makeService({ marvUserId: 'marv-id' });
      const result = await svc.sendNotConfiguredDm({
        userId: 'marv-id',
        conversationId: 'c1',
      });
      expect(result.messageId).toBeNull();
      expect(messages.sendBotDirectMessage).not.toHaveBeenCalled();
    });
  });
});
