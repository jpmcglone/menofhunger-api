import { ServiceUnavailableException } from '@nestjs/common';
import { AdminAnalyticsBriefService } from './admin-analytics-brief.service';
import { MarvinAINotConfiguredError } from '../marvin/services/marvin-ai.service';

function build(opts?: {
  configured?: boolean;
  text?: string;
  respond?: jest.Mock;
}) {
  const respond = opts?.respond ?? jest.fn(async () => ({ text: opts?.text ?? 'Growth is steady.' }));
  const ai = {
    isConfigured: jest.fn(() => opts?.configured ?? true),
    respond,
  };
  const service = new AdminAnalyticsBriefService(ai as any);
  return { service, ai, respond };
}

describe('AdminAnalyticsBriefService', () => {
  it('sends the loaded snapshot to Marv and returns the brief', async () => {
    const { service, respond } = build({ text: 'DAU is up. Watch activation.' });
    const result = await service.brief('admin-1', {
      range: '30d',
      analytics: { summary: { totalUsers: 12, dau: 4 }, signups: [{ bucket: '2026-08-01', count: 2 }] },
      referrals: { totalRecruits: 3 },
    });

    expect(result.brief).toBe('DAU is up. Watch activation.');
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'catch_up',
        mode: 'regular',
        toolContext: { requesterUserId: 'admin-1' },
      }),
    );
    const userMessage = String(respond.mock.calls[0][0].userMessage);
    expect(userMessage).toContain('"range":"30d"');
    expect(userMessage).toContain('"totalUsers":12');
    expect(userMessage).toContain('"totalRecruits":3');
  });

  it('keeps only the newest series points when the snapshot is long', async () => {
    const { service, respond } = build();
    const signups = Array.from({ length: 80 }, (_, i) => ({ bucket: `d${i}`, count: i }));
    await service.brief('admin-1', {
      range: '1y',
      analytics: { signups },
    });
    const snapshot = JSON.parse(String(respond.mock.calls[0][0].userMessage)) as {
      analytics: { signups: Array<{ bucket: string }> };
    };
    expect(snapshot.analytics.signups).toHaveLength(30);
    expect(snapshot.analytics.signups[0]?.bucket).toBe('d50');
  });

  it('throws when Marv is not configured', async () => {
    const { service } = build({ configured: false });
    await expect(
      service.brief('admin-1', { range: '7d', analytics: { summary: {} } }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('throws a friendly error when the AI call fails', async () => {
    const { service } = build({
      respond: jest.fn(async () => {
        throw new MarvinAINotConfiguredError();
      }),
    });
    await expect(
      service.brief('admin-1', { range: '7d', analytics: { summary: {} } }),
    ).rejects.toMatchObject({ message: 'Marv is not configured on this server.' });
  });
});
