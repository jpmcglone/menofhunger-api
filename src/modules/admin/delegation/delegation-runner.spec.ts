jest.mock('../../mcp/mcp-tools', () => ({ sharedTools: { schema: () => ({}), guidance: () => '', sanitize: (v: unknown) => v } }));
import { DelegationRunnerService } from './delegation-runner.service';

describe('sourced-news runner', () => {
  function setup({ fetchSource = true, webSearchCount = 1, revoke = false } = {}) {
    const job = { id: 'job', ownerId: 'admin', actorId: 'page', title: 'News', instruction: 'Publish news', workflow: 'news', permission: 'publish_news', revision: 1, status: 'active' };
    const run = { id: 'run', status: 'queued', job, jobSnapshot: job };
    let proposals: any[] = [];
    const prisma: any = {
      delegationJob: { findUnique: jest.fn(async () => job) },
      delegationRun: { findUnique: jest.fn(async () => run), updateMany: jest.fn(async () => ({ count: 1 })), findMany: jest.fn(async () => []), update: jest.fn(async ({ data }) => { if (data.actions) proposals = data.actions.create; return {}; }) },
      delegationAction: { findMany: jest.fn(async () => proposals.filter(a => a.operation === 'post_publish').map((a,i) => ({ ...a, id: String(i) }))) },
    };
    prisma.$transaction = async (fn: any) => fn(prisma);
    const policy = { assertActor: jest.fn(async () => { if (revoke) throw new Error('revoked'); return {}; }) };
    const service = { notify: jest.fn(), configured: jest.fn(async () => true), decide: jest.fn(async () => ({})) };
    const actions = { snapshot: jest.fn(async () => ({ id: null, body: null })) };
    const url = 'https://example.com/report';
    const toolErrors: any[] = [];
    const ai = { respond: jest.fn(async (request: any) => {
      if (fetchSource) await request.dispatchTool('fetch_url_content',{ url },{});
      const result = await request.dispatchTool('prepare_action',{ action: { operation: 'post_publish', body: 'An original news summary.', sources: [{ title: 'Reporting', url }] } },{});
      toolErrors.push(JSON.parse(result));
      return { text: 'News prepared.', webSearchCount, errorCode: null };
    }) };
    const tools = { dispatch: jest.fn(async () => JSON.stringify({ content: 'Verified reporting. '.repeat(20) })) };
    const runner = new DelegationRunnerService(prisma, policy as any, service as any, actions as any, { read: async () => ({}) } as any, ai as any, tools as any, { recordEvent: jest.fn() } as any);
    return { runner, prisma, policy, service, ai, toolErrors };
  }
  it('requires both a fetched source and web-search evidence before automatic publication', async () => {
    const { runner,service,ai } = setup(); await runner.run('run');
    expect(ai.respond).toHaveBeenCalledWith(expect.objectContaining({ source: 'admin_console', adminWebSearch: true }));
    expect(service.decide).toHaveBeenCalledWith('admin','0','confirm');
  });
  it('rejects fabricated citations', async () => {
    const { runner,service,toolErrors } = setup({ fetchSource: false }); await runner.run('run');
    expect(toolErrors[0].error).toMatch(/fetch_sources/);
    expect(service.decide).not.toHaveBeenCalled();
  });
  it('leaves a proposal for review when the provider did not search', async () => {
    const { runner,service,prisma } = setup({ webSearchCount: 0 }); await runner.run('run');
    expect(service.decide).not.toHaveBeenCalled();
    expect(prisma.delegationRun.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'review' }) }));
  });
  it('stops before paid research when admin or page access was revoked', async () => {
    const { runner,service,ai } = setup({ revoke: true }); await runner.run('run');
    expect(ai.respond).not.toHaveBeenCalled();
    expect(service.decide).not.toHaveBeenCalled();
  });
  it('does not process an already completed queue delivery', async () => {
    const { runner,prisma,ai } = setup(); prisma.delegationRun.findUnique.mockResolvedValue({ status: 'complete' });
    await runner.run('run'); expect(ai.respond).not.toHaveBeenCalled();
  });
});
