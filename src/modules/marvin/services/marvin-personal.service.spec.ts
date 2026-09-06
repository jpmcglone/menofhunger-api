import { MarvinPersonalService } from './marvin-personal.service';

function setup() {
  const rows: any[] = [];
  const prisma: any = {
    messageConversation: { findFirst: jest.fn(async () => ({ participants: [{ userId: 'member', user: { botType: null } }, { userId: 'marv', user: { botType: 'marvin' } }] })) },
    message: { findFirst: jest.fn(async () => ({ id: 'message' })) },
    post: { findFirst: jest.fn(async () => ({ body: 'A real post', user: { username: 'john' } })) },
    marvinPersonalAction: {
      findUnique: jest.fn(async ({ where }: any) => rows.find(r => r.requestKey === where.requestKey)),
      findFirst: jest.fn(async ({ where }: any) => rows.find(r => r.id === where.id && r.userId === where.userId)),
      findFirstOrThrow: jest.fn(async ({ where }: any) => rows.find(r => r.id === where.id && r.userId === where.userId)),
      count: jest.fn(async () => rows.length),
      create: jest.fn(async ({ data }: any) => { const row = { id: `action-${rows.length}`, createdAt: new Date(), status: 'pending', receipt: null, ...data }; rows.push(row); return row; }),
      updateMany: jest.fn(async ({ where, data }: any) => { const row = rows.find(r => r.id === where.id && r.userId === where.userId && r.status === where.status); if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 }; }),
      update: jest.fn(async ({ where, data }: any) => { const row = rows.find(r => r.id === where.id); Object.assign(row, data); return row; }),
      findMany: jest.fn(async ({ where }: any) => rows.filter(r => r.userId === where.userId)),
    },
  };
  const bookmarks: any = { setBookmark: jest.fn(async () => ({})) };
  const preferences: any = { getPreferences: jest.fn(async () => ({ pushBoost: true })), updatePreferences: jest.fn(async (_id, changes) => changes) };
  const realtime: any = { emitMarvActionsUpdated: jest.fn() };
  return { svc: new MarvinPersonalService(prisma, bookmarks, preferences, realtime), prisma, bookmarks, preferences, realtime, rows };
}
const ctx = { requesterUserId: 'member', requesterMessageId: 'message', conversationId: 'direct' };

describe('personal MARV actions', () => {
  it('prepares without writing, deduplicates the same request, and emits only an owner invalidation', async () => {
    const { svc, bookmarks, realtime, rows } = setup();
    const input = { action: { kind: 'bookmark', postId: 'post' } };
    await svc.prepare(input, ctx);
    await svc.prepare(input, ctx);
    expect(rows).toHaveLength(1);
    expect(bookmarks.setBookmark).not.toHaveBeenCalled();
    expect(realtime.emitMarvActionsUpdated).toHaveBeenCalledWith('member');
  });
  it('requires a real private MARV conversation and a current message from its owner', async () => {
    const { svc, prisma } = setup();
    const action = { action: { kind: 'draft', title: 'Check-in', body: 'My week' } };
    await expect(svc.prepare(action, { requesterUserId: 'member' })).rejects.toThrow('private chat');
    prisma.messageConversation.findFirst.mockResolvedValue({ participants: [] });
    await expect(svc.prepare(action, ctx)).rejects.toThrow('private chat');
    expect(prisma.marvinPersonalAction.create).not.toHaveBeenCalled();
  });
  it('prevents another user from confirming, and applies a bookmark once under concurrent clicks', async () => {
    const { svc, bookmarks } = setup();
    const action = await svc.prepare({ action: { kind: 'bookmark', postId: 'post' } }, ctx);
    await expect(svc.decide('other', action.id, 'confirm')).rejects.toThrow('not found');
    await Promise.all([svc.decide('member', action.id, 'confirm'), svc.decide('member', action.id, 'confirm')]);
    expect(bookmarks.setBookmark).toHaveBeenCalledTimes(1);
    expect(bookmarks.setBookmark).toHaveBeenCalledWith({ userId: 'member', postId: 'post', collectionIds: null });
  });
  it('expires and cancels proposals without a write', async () => {
    const { svc, rows, bookmarks } = setup();
    const action = await svc.prepare({ action: { kind: 'bookmark', postId: 'post' } }, ctx);
    rows[0].expiresAt = new Date(0);
    expect((await svc.decide('member', action.id, 'confirm')).status).toBe('expired');
    expect(bookmarks.setBookmark).not.toHaveBeenCalled();
  });
  it('rejects stale notification changes and keeps uncertain failures terminal', async () => {
    const { svc, preferences } = setup();
    const action = await svc.prepare({ action: { kind: 'preferences', changes: { pushBoost: false } } }, ctx);
    preferences.getPreferences.mockResolvedValue({ pushBoost: false });
    const result = await svc.decide('member', action.id, 'confirm');
    expect(result.status).toBe('failed');
    expect(result.receipt).toContain('changed');
    await svc.decide('member', action.id, 'confirm');
    expect(preferences.updatePreferences).not.toHaveBeenCalled();
  });
  it('keeps a draft without publishing a post or recording a check-in', async () => {
    const { svc, bookmarks, preferences } = setup();
    const action = await svc.prepare({ action: { kind: 'draft', title: 'Weekly check-in', body: 'A week of progress.' } }, ctx);
    const result = await svc.decide('member', action.id, 'confirm');
    expect(result.draft).toBe('A week of progress.');
    expect(result.receipt).toContain('not been published');
    expect(bookmarks.setBookmark).not.toHaveBeenCalled();
    expect(preferences.updatePreferences).not.toHaveBeenCalled();
  });
});
