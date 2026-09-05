import { ServiceUnavailableException } from '@nestjs/common';
import { AdminIntroBriefService } from './admin-intro-brief.service';

function makeService(opts?: { configured?: boolean; text?: string | null; candidates?: any[] }) {
  const saved = {
    weekKey: '2026-W36',
    brief: 'Introduce these two.',
    pairsJson: [],
    modelUsed: 'gpt-6-astra',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  };
  const prisma: any = {
    adminIntroBrief: {
      findFirst: jest.fn(async () => saved),
      upsert: jest.fn(async ({ create }: any) => ({ ...saved, ...create, createdAt: saved.createdAt })),
    },
    $queryRaw: jest.fn(async () => opts?.candidates ?? [
      {
        leftUserId: 'a',
        leftUsername: 'abel',
        leftName: 'Abel',
        rightUserId: 'b',
        rightUsername: 'ben',
        rightName: 'Ben',
        topics: ['faith', 'bible'],
        groups: ['Iron Church'],
        overlap: 2,
        groupOverlap: 1,
      },
    ]),
  };
  const ai: any = {
    isConfigured: jest.fn(() => opts?.configured !== false),
    complete: jest.fn(async () =>
      opts?.text === null
        ? null
        : {
            text:
              opts?.text ??
              JSON.stringify({
                brief: 'Abel and Ben should meet.',
                pairs: [
                  {
                    leftUsername: 'abel',
                    rightUsername: 'ben',
                    topics: ['faith'],
                    groups: ['Iron Church'],
                    reason: 'Both writing about the same texts.',
                  },
                ],
              }),
            modelUsed: 'gpt-6-astra',
          },
    ),
  };
  const appConfig: any = { marvOpenAI: jest.fn(() => ({ astraModel: 'gpt-6-astra' })) };
  const jobs: any = { enqueue: jest.fn(async () => ({ id: 'job' })) };
  return { service: new AdminIntroBriefService(prisma, ai, appConfig, jobs), prisma, ai, jobs };
}

describe('AdminIntroBriefService', () => {
  it('returns the latest stored brief', async () => {
    const { service } = makeService();
    const latest = await service.latest();
    expect(latest?.weekKey).toBe('2026-W36');
    expect(latest?.createdAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('writes Astra-picked pairs that match the candidate list', async () => {
    const { service, prisma } = makeService();
    const result = await service.generate();
    expect(result.brief).toBe('Abel and Ben should meet.');
    expect(result.pairs).toEqual([
      {
        left: { id: 'a', username: 'abel', name: 'Abel' },
        right: { id: 'b', username: 'ben', name: 'Ben' },
        topics: ['faith', 'bible'],
        groups: ['Iron Church'],
        reason: 'Both writing about the same texts.',
      },
    ]);
    expect(prisma.adminIntroBrief.upsert).toHaveBeenCalled();
  });

  it('stores a no-candidates brief without calling Astra', async () => {
    const { service, ai } = makeService({ candidates: [] });
    const result = await service.generate();
    expect(result.modelUsed).toBe('none');
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it('queues generate instead of waiting on Astra', async () => {
    const { service, jobs, ai } = makeService();
    const queued = await service.enqueueGenerate();
    expect(queued.queued).toBe(true);
    expect(queued.weekKey).toMatch(/^\d{4}-W\d{2}$/);
    expect(jobs.enqueue).toHaveBeenCalledWith(
      'admin.introBrief',
      {},
      expect.objectContaining({ jobId: `admin-intro-brief-${queued.weekKey}` }),
    );
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it('keeps a group-only pair when Astra omits topics', async () => {
    const { service } = makeService({
      candidates: [
        {
          leftUserId: 'a',
          leftUsername: 'abel',
          leftName: 'Abel',
          rightUserId: 'b',
          rightUsername: 'ben',
          rightName: 'Ben',
          topics: [],
          groups: ['Dawn Patrol'],
          overlap: 0,
          groupOverlap: 1,
        },
      ],
      text: JSON.stringify({
        brief: 'They already sit in the same room.',
        pairs: [
          {
            leftUsername: 'abel',
            rightUsername: 'ben',
            topics: [],
            groups: ['Dawn Patrol'],
            reason: 'Same group, no follow yet.',
          },
        ],
      }),
    });
    const result = await service.generate();
    expect(result.pairs).toEqual([
      {
        left: { id: 'a', username: 'abel', name: 'Abel' },
        right: { id: 'b', username: 'ben', name: 'Ben' },
        topics: [],
        groups: ['Dawn Patrol'],
        reason: 'Same group, no follow yet.',
      },
    ]);
  });

  it('throws when OpenAI is missing', async () => {
    const { service } = makeService({ configured: false });
    await expect(service.generate()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
