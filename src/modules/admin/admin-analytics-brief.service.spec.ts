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
        source: 'admin_console',
        mode: 'regular',
        toolContext: { requesterUserId: 'admin-1' },
      }),
    );
    const userMessage = String(respond.mock.calls[0][0].userMessage);
    const note = String(respond.mock.calls[0][0].developerNote);
    expect(userMessage).toContain('"range":"30d"');
    expect(userMessage).toContain('"totalUsers":12');
    expect(userMessage).toContain('"totalRecruits":3');
    expect(note).toContain('the last 30 days');
    expect(note).toContain('channel');
  });

  it('sums the full selected range and keeps quiet groups out of the active list', async () => {
    const { service, respond } = build();
    const signups = Array.from({ length: 80 }, (_, i) => ({ bucket: `d${i}`, count: i }));
    await service.brief('admin-1', {
      range: '3m',
      analytics: {
        asOf: '2026-10-08T16:00:00.000Z',
        summary: { mau: 42, totalUsers: 71, dau: 11 },
        signups,
        groups: {
          activeGroups: 4,
          groupRootPostsInRange: 9,
          topGroups: [
            { name: 'NoFat', slug: 'nofat', rootPostsInRange: 0, memberCount: 40 },
            { name: 'Lodge', slug: 'lodge', rootPostsInRange: 9, memberCount: 12 },
          ],
        },
        channels: {
          messagesInRange: 120,
          topChannels: [
            { groupName: 'Lodge', groupSlug: 'lodge', channelName: 'general', messagesInRange: 80, sendersInRange: 6 },
          ],
        },
      },
    });
    const snapshot = JSON.parse(String(respond.mock.calls[0][0].userMessage)) as {
      selectedRange: {
        label: string;
        signups: number;
        averageDailyActiveUsers: number;
        groups: { groupsWithFeedPosts: Array<{ name: string }> };
        channels: { messagesInRange: number; groupsByChannelMessages: Array<{ groupSlug: string }> };
      };
      notTheSelectedRange: { last30Days: { mau: number } };
    };
    expect(snapshot.selectedRange.label).toBe('the last 3 months (90 days)');
    expect(snapshot.selectedRange.signups).toBe(3160);
    expect(snapshot.selectedRange.averageDailyActiveUsers).toBe(11);
    expect(snapshot.selectedRange.groups.groupsWithFeedPosts.map((group) => group.name)).toEqual(['Lodge']);
    expect(snapshot.selectedRange.channels.messagesInRange).toBe(120);
    expect(snapshot.selectedRange.channels.groupsByChannelMessages[0]?.groupSlug).toBe('lodge');
    expect(snapshot.notTheSelectedRange.last30Days.mau).toBe(42);
    expect(String(respond.mock.calls[0][0].developerNote)).toContain('the last 3 months');
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
