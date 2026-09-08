import { DelegationPolicyService } from './delegation-policy.service';
import { DelegationService } from './delegation.service';
import { DelegationActionsService, publicationBody } from './delegation-actions.service';
import { jobInputSchema, actionSchema, scheduleSchema } from './delegation.schemas';
import { nextDelegationRun } from './delegation.schedule';

const admin = { id: 'admin', username: 'john', name: 'John', siteAdmin: true, accountKind: 'person', bannedAt: null };
const page = { id: 'page', username: 'mohnews', name: 'News', accountKind: 'page' };
describe('delegated identity and standing permissions', () => {
  const setup = () => {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(admin) }, userPageOperator: { findMany: jest.fn().mockResolvedValue([{ page }]) } };
    return { prisma, policy: new DelegationPolicyService(prisma as any) };
  };
  it('defaults to the personal account and resolves only explicit operated pages', async () => {
    const { policy } = setup();
    expect((await policy.actor('admin')).id).toBe('admin');
    expect((await policy.actor('admin', '@MOHNEWS')).id).toBe('page');
    await expect(policy.actor('admin', 'someoneelse')).rejects.toThrow('Choose your account');
  });
  it.each([{ ...admin, siteAdmin: false }, { ...admin, accountKind: 'page' }, { ...admin, bannedAt: new Date() }, null])('hides the feature from an ineligible owner', async owner => {
    const { prisma, policy } = setup(); prisma.user.findUnique.mockResolvedValue(owner);
    await expect(policy.accounts('admin')).rejects.toMatchObject({ status: 404 });
    expect(prisma.userPageOperator.findMany).not.toHaveBeenCalled();
  });
  it('rechecks revoked page operation on every action', async () => {
    const { prisma, policy } = setup(); await policy.assertActor('admin', 'page');
    prisma.userPageOperator.findMany.mockResolvedValue([]);
    await expect(policy.assertActor('admin', 'page')).rejects.toMatchObject({ status: 404 });
  });
  it('cannot grant automatic execution outside sourced news or accept arbitrary media keys', () => {
    expect(jobInputSchema.safeParse({ id: 'ab335830-441b-4d02-85e0-ea7418c28c22', title: 'Community', instruction: 'Welcome members', workflow: 'community', permission: 'publish_news', schedule: { frequency: 'once' } }).success).toBe(false);
    expect(actionSchema.safeParse({ operation: 'post_publish', body: 'News', media: [{ r2Key: 'other-user/key' }] }).success).toBe(false);
  });
});

describe('delegated scheduling', () => {
  const next = (time: string, after: string) => nextDelegationRun(scheduleSchema.parse({ frequency: 'daily', time, timeZone: 'America/New_York' }), new Date(after))?.toISOString();
  it('uses the selected wall clock rather than the server time zone', () => { expect(next('08:00', '2026-09-07T11:59:00Z')).toBe('2026-09-07T12:00:00.000Z'); });
  it('skips the missing spring-forward time', () => { expect(next('02:30', '2026-03-08T05:00:00Z')).toBe('2026-03-09T06:30:00.000Z'); });
  it('does not run twice during the fall-back hour', () => { expect(next('01:30', '2026-11-01T05:30:00Z')).toBe('2026-11-02T06:30:00.000Z'); });
  it('schedules weekly work on the selected weekday', () => { expect(nextDelegationRun(scheduleSchema.parse({ frequency: 'weekly', weekday: 1, time: '08:00', timeZone: 'UTC' }), new Date('2026-09-07T08:00:00Z'))?.toISOString()).toBe('2026-09-14T08:00:00.000Z'); });
});

describe('review execution', () => {
  const setup = () => {
    const job = { id: 'job', ownerId: 'admin', actorId: 'page', workflow: 'news', status: 'active', revision: 2 };
    const action = { id: 'action', runId: 'run', operation: 'post_publish', title: 'Publish', input: actionSchema.parse({ operation: 'post_publish', body: 'News' }), before: { id: null, body: null }, status: 'pending', receipt: null, path: null, createdAt: new Date(), run: { status: 'review', jobSnapshot: { revision: 2 }, job } };
    let claimed = false;
    const prisma = { delegationAction: {
      findFirst: jest.fn().mockResolvedValue(action),
      updateMany: jest.fn(async ({ data }) => { if (claimed) return { count: 0 }; claimed = true; Object.assign(action, data); return { count: 1 }; }),
      update: jest.fn(async ({ data }) => Object.assign(action, data)),
      findUniqueOrThrow: jest.fn(async () => action),
      findMany: jest.fn(async () => [{ status: action.status }]),
    }, delegationRun: { updateMany: jest.fn() } };
    const policy = { assertActor: jest.fn().mockResolvedValue(page) };
    const actions = { snapshot: jest.fn(async () => ({ id: null, body: null })), execute: jest.fn().mockResolvedValue({ receipt: 'Published', path: '/p/result' }) };
    const service = new DelegationService(prisma as any, policy as any, actions as any, {} as any, { emitAdminUpdated: jest.fn() } as any, {} as any, {} as any, {} as any);
    return { action, job, prisma, policy, actions, service };
  };
  it('applies one action at most once even with concurrent confirms', async () => {
    const { service, actions } = setup();
    await Promise.all([service.decide('admin','action','confirm'), service.decide('admin','action','confirm')]);
    expect(actions.execute).toHaveBeenCalledTimes(1);
    expect(actions.execute).toHaveBeenCalledWith('admin','page', expect.objectContaining({ body: 'News' }));
  });
  it('does not apply a stale job revision', async () => {
    const { service, job, actions } = setup(); job.revision++;
    await expect(service.decide('admin','action','confirm')).rejects.toThrow('job changed');
    expect(actions.execute).not.toHaveBeenCalled();
  });
  it('rejects changed evidence and missing owner access before claiming a write', async () => {
    const { service, actions, prisma } = setup(); actions.snapshot.mockResolvedValue({ id: 'changed', body: null } as any);
    await expect(service.decide('admin','action','confirm')).rejects.toThrow('item changed');
    expect(prisma.delegationAction.updateMany).not.toHaveBeenCalled();
    expect(prisma.delegationAction.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'action', run: { job: { ownerId: 'admin' } } } }));
  });
  it('retains edited text and records an uncertain write without retrying it', async () => {
    const { service, actions, action } = setup(); actions.execute.mockRejectedValue(new Error('transport lost'));
    await service.decide('admin','action','confirm','Edited news');
    expect(action.status).toBe('uncertain');
    expect(actions.execute).toHaveBeenCalledWith('admin','page',expect.objectContaining({ body: 'Edited news' }));
    await service.decide('admin','action','confirm');
    expect(actions.execute).toHaveBeenCalledTimes(1);
  });
  it('dismissal never executes a proposal', async () => {
    const { service, actions } = setup(); await service.decide('admin','action','cancel');
    expect(actions.execute).not.toHaveBeenCalled();
  });
});

describe('canonical draft and media execution', () => {
  const setup = () => {
    const prisma = { post: { findFirst: jest.fn().mockResolvedValue(null) } };
    const posts = { publishFromOnlyMe: jest.fn().mockResolvedValue({ id: 'result' }), createPost: jest.fn(), updateDraft: jest.fn() };
    const service = new DelegationActionsService(prisma as any,posts as any,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any);
    return { prisma, posts, service };
  };
  it('rejects a draft owned by another account before review', async () => {
    const { service, prisma } = setup();
    await expect(service.snapshot('page',actionSchema.parse({ operation: 'post_publish', body: 'News', draftId: 'foreign' }))).rejects.toThrow('owned by this account');
    expect(prisma.post.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'page', isDraft: true }) }));
  });
  it('publishes through the existing media resolver and edits without dropping attachments', async () => {
    const { service, posts } = setup();
    await service.execute('admin','page',{ operation: 'post_publish', body: 'News', draftId: 'draft' });
    expect(posts.publishFromOnlyMe).toHaveBeenCalledWith(expect.objectContaining({ userId: 'page', sourcePostId: 'draft' }));
    expect(posts.createPost).not.toHaveBeenCalled();
    await service.execute('admin','page',{ operation: 'post_draft_update', draftId: 'draft', body: 'Edited' });
    expect(posts.updateDraft).toHaveBeenCalledWith({ userId: 'page', draftId: 'draft', body: 'Edited', media: null });
  });
  it('retains citations exactly once in published text', () => {
    const source = { title: 'Reporting', url: 'https://example.com/report' };
    expect(publicationBody(actionSchema.parse({ operation: 'post_publish', body: source.url, sources: [source] }) as any)).toBe(source.url);
  });
});
