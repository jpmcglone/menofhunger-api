import { readChannelsAnalytics } from './admin-analytics-channels.read';

function sqlText(call: unknown[]): string {
  const query = call[0] as { strings?: string[]; sql?: string };
  return query.sql ?? (query.strings ?? []).join('?');
}

describe('readChannelsAnalytics', () => {
  it('reports human channel messages apart from group posts, excluding bots and archived channels', async () => {
    const results = [
      [{ active: 5n, private_count: 1n, groups_with: 3n }],
      [{ messages: 40n, thread_replies: 6n, senders: 8n, channels: 4n }],
      [{ cnt: 3n }],
      [{ cnt: 11n }],
      [{ cnt: 2n }],
      [{ cnt: 9n }],
      [{ bucket: new Date('2026-09-24T00:00:00Z'), count: 7n }],
      [{ id: 'c1', slug: 'nxr', group_name: 'Men of NXR', channel_name: 'general', is_private: false, messages: 30n, senders: 6n }],
    ];
    const prisma = { $queryRaw: jest.fn(async () => results.shift()) };

    const channels = await readChannelsAnalytics(prisma as never, { since: new Date('2026-09-18T00:00:00Z'), granularity: 'day' });

    expect(channels).toMatchObject({
      activeChannels: 5,
      privateChannels: 1,
      groupsWithChannels: 3,
      messagesInRange: 40,
      threadRepliesInRange: 6,
      marvRepliesInRange: 3,
      mentionsInRange: 11,
      uploadsInRange: 2,
      sendersInRange: 8,
      readersInRange: 9,
      channelsWithActivityInRange: 4,
      messages: [{ bucket: '2026-09-24', count: 7 }],
    });
    expect(channels.topChannels[0]).toMatchObject({ groupSlug: 'nxr', channelName: 'general', messagesInRange: 30 });

    const summarySql = sqlText(prisma.$queryRaw.mock.calls[1] as unknown[]);
    expect(summarySql).toContain(`u."isBot" = false`);
    expect(summarySql).toContain(`gc."archivedAt" IS NULL`);
  });
});
