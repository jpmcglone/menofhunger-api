import { PickaxController } from './pickax.controller';

describe('Pickax reconnect endpoint', () => {
  function harness() {
    const reconnect = jest.fn(async () => ({ connected: true, needsAttention: false, username: 'alice' }));
    const controller = new PickaxController({ reconnect } as any,
      { run: jest.fn(async (_user, _path, _key, _input, action) => action()) } as any, {} as any);
    const req: any = { user: { operatedByUserId: 'operator' }, path: '/me/integrations/pickax/reconnect', get: () => undefined };
    return { controller, reconnect, req };
  }
  it('uses only the authenticated account and records the current page operator', async () => {
    const h = harness();
    expect(await h.controller.reconnect('page', h.req)).toEqual({ data: {
      connected: true, needsAttention: false, username: 'alice', needsUsername: false, verificationCode: null,
    } });
    expect(h.reconnect).toHaveBeenCalledWith('page', 'operator');
  });
  it('rejects impersonation before using saved credentials', async () => {
    const h = harness(); h.req.user.impersonatedByUserId = 'admin';
    await expect(h.controller.reconnect('member', h.req)).rejects.toThrow('End impersonation');
    expect(h.reconnect).not.toHaveBeenCalled();
  });
});
