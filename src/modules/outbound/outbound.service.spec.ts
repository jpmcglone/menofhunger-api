import { OutboundService } from './outbound.service';

describe('outbound lifecycle', () => {
  function harness() {
    let row: any = { id: 'delivery', userId: 'member', platform: 'x', resourceKind: 'post', resourceId: 'post', connectionGeneration: 'generation', externalAccountId: 'external', action: 'create', version: 1, status: 'pending', remoteId: null, attempts: 0, leaseUntil: null, nextAttemptAt: new Date(0) };
    const matches = (where: any) => Object.entries(where).every(([k, v]) => k === 'OR' || (v instanceof Date ? row[k]?.getTime() === v.getTime() : row[k] === v));
    const updateMany = jest.fn(async ({ where, data }: any) => { if (!matches(where)) return { count: 0 }; row = { ...row, ...data, attempts: data.attempts ? row.attempts + 1 : row.attempts }; return { count: 1 }; });
    const prisma: any = {
      outboundDelivery: { findUnique: jest.fn(async () => ({ ...row })), updateMany, update: jest.fn(async ({ data }: any) => { row = { ...row, ...data }; return row; }) },
      xConnection: { findUnique: jest.fn(async () => ({ generation: 'generation', xUserId: 'external' })) },
      user: { findUnique: jest.fn(async () => ({ verifiedStatus: 'identity', accountKind: 'person', bannedAt: null })) },
      xCrosspost: { findUnique: jest.fn(async () => ({ remoteId: 'remote', lastError: null })) },
    };
    const service = new OutboundService(prisma, { partner: () => ({ outboundPaused: false }) } as any, { dispatch: jest.fn() } as any, {} as any);
    const send = jest.fn(), remove = jest.fn(); service.register('x', { send, remove });
    return { service, send, remove, prisma, get row() { return row; }, set row(next) { row = next; } };
  }
  it('claims once and duplicate jobs do not create more copies', async () => {
    const h = harness(); h.send.mockResolvedValue(undefined);
    await Promise.all([h.service.deliver('delivery'), h.service.deliver('delivery')]);
    expect(h.send).toHaveBeenCalledTimes(1); expect(h.row.status).toBe('sent');
  });
  it('waits for an in-flight create, then removes its confirmed remote identity', async () => {
    const h = harness(); let finish!: () => void;
    h.send.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const sending = h.service.deliver('delivery');
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    h.row = { ...h.row, version: 2, action: 'remove', status: 'pending' };
    await h.service.deliver('delivery'); expect(h.remove).not.toHaveBeenCalled();
    finish(); await sending;
    expect(h.row).toMatchObject({ action: 'remove', status: 'pending', remoteId: 'remote', leaseUntil: null });
    await h.service.deliver('delivery'); expect(h.remove).toHaveBeenCalledWith(expect.objectContaining({ remoteId: 'remote' }));
    expect(h.row.status).toBe('removed');
  });
  it('does not retry an ambiguous create or redirect an old job after reconnect', async () => {
    const h = harness(); h.send.mockRejectedValue(new Error('Connection reset after send'));
    await h.service.deliver('delivery'); expect(h.row.status).toBe('needs_attention');
    await h.service.deliver('delivery'); expect(h.send).toHaveBeenCalledTimes(1);
    h.row = { ...h.row, status: 'pending', nextAttemptAt: new Date(0), connectionGeneration: 'old' };
    await h.service.deliver('delivery'); expect(h.row.status).toBe('cancelled'); expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('suspends page delivery when its authorizing operator is banned', async () => {
    const h = harness();
    h.prisma.xConnection.findUnique.mockResolvedValue({ generation: 'generation', xUserId: 'external', authorizedByUserId: 'operator' });
    h.prisma.user.findUnique.mockImplementation(async ({ where }: any) => where.id === 'member'
      ? { verifiedStatus: 'identity', accountKind: 'page', bannedAt: null }
      : { accountKind: 'person', bannedAt: new Date() });
    h.prisma.userPageOperator = { findUnique: jest.fn(async () => ({ operatorUserId: 'operator' })) };
    await h.service.deliver('delivery');
    expect(h.row.status).toBe('needs_attention');
    expect(h.send).not.toHaveBeenCalled();
  });
  it('does not publish when verification is missing even if the account is Premium', async () => {
    const h = harness();
    h.prisma.user.findUnique.mockResolvedValue({ verifiedStatus: 'none', premium: true, accountKind: 'person' });
    await h.service.deliver('delivery');
    expect(h.row.status).toBe('cancelled'); expect(h.send).not.toHaveBeenCalled();
  });
  it('retries throttling without retrying an unconfirmed removal as a success', async () => {
    const h = harness(); h.row = { ...h.row, action: 'remove', remoteId: 'remote' };
    h.remove.mockRejectedValue({ status: 429, retryAfterSeconds: 60 });
    await h.service.deliver('delivery');
    expect(h.row.status).toBe('pending'); expect(h.row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(h.row.status).not.toBe('removed');
  });

  it('does not claim removal succeeded after an ambiguous create without a remote ID', async () => {
    const h = harness(); h.row = { ...h.row, action: 'remove', attempts: 1 };
    h.prisma.xCrosspost.findUnique.mockResolvedValue({ remoteId: null });
    await h.service.deliver('delivery');
    expect(h.row.status).toBe('needs_attention'); expect(h.remove).not.toHaveBeenCalled();
  });
  it('cancels never-sent work without claiming a remote copy was deleted', async () => {
    const h = harness(); h.row = { ...h.row, action: 'remove' };
    await h.service.deliver('delivery');
    expect(h.row.status).toBe('cancelled'); expect(h.remove).not.toHaveBeenCalled();
  });

});
