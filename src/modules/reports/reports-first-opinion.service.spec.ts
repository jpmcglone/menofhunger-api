import { ReportsFirstOpinionService } from './reports-first-opinion.service';

function fixture(report: Record<string, unknown> | null, answer: { valid: number; harm: number } | null, configured = true) {
  const prisma = { report: { findUnique: jest.fn(async () => report), updateMany: jest.fn(async () => ({ count: 1 })) } };
  const decide = jest.fn(async () =>
    answer ? { answers: { category: { choice: 'harassment' }, validViolation: { noul: answer.valid }, seriousHarm: { noul: answer.harm } } } : null,
  );
  const service = new ReportsFirstOpinionService(prisma as never, { isConfigured: () => configured, decide } as never, { register: jest.fn() } as never);
  return { service, prisma, decide };
}
const base = { id: 'r1', reason: 'harassment', details: 'He keeps threatening me', jevScoredAt: null, subjectPost: null };

describe('ReportsFirstOpinionService', () => {
  it('stores the likelihood and uses the larger score as queue priority', async () => {
    const f = fixture(base, { valid: 0.4, harm: 0.8 });
    await f.service.score({ reportId: 'r1' });
    expect(f.prisma.report.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', jevScoredAt: null },
      data: expect.objectContaining({ jevCategory: 'harassment', jevValidScore: 0.4, jevHarmScore: 0.8, jevPriority: 0.8 }),
    });
  });

  it('sends the reported post only when it is public and ungrouped', async () => {
    const pub = fixture({ ...base, subjectPost: { body: 'public text', visibility: 'public', communityGroupId: null, deletedAt: null } }, { valid: 0.5, harm: 0 });
    await pub.service.score({ reportId: 'r1' });
    expect((pub.decide.mock.calls[0] as any)[0].state.reportedPostText).toBe('public text');

    const grouped = fixture({ ...base, subjectPost: { body: 'secret', visibility: 'public', communityGroupId: 'g', deletedAt: null } }, { valid: 0.5, harm: 0 });
    await grouped.service.score({ reportId: 'r1' });
    expect((grouped.decide.mock.calls[0] as any)[0].state.reportedPostText).toBe('');
  });

  it('gives a neutral priority, without calling Jev, when there is no text to judge', async () => {
    const f = fixture({ ...base, details: null }, { valid: 1, harm: 1 });
    await f.service.score({ reportId: 'r1' });
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.prisma.report.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ jevPriority: 0.5 }) }));
  });

  it('retries when Jev is unavailable and skips reports already scored', async () => {
    await expect(fixture(base, null).service.score({ reportId: 'r1' })).rejects.toThrow();
    const scored = fixture({ ...base, jevScoredAt: new Date() }, { valid: 1, harm: 1 });
    await scored.service.score({ reportId: 'r1' });
    expect(scored.decide).not.toHaveBeenCalled();
    const off = fixture(base, { valid: 1, harm: 1 }, false);
    await off.service.score({ reportId: 'r1' });
    expect(off.prisma.report.findUnique).not.toHaveBeenCalled();
  });
});
