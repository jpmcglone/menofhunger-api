import { NotFoundException } from '@nestjs/common';
import { ReportsService } from './reports.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SlackService } from '../../common/slack/slack.service';
import type { ChannelAccessService } from '../group-channels/channel-access.service';
import type { ChannelMediaService } from '../group-channels/channel-media.service';
import type { MessagesService } from '../messages/messages.service';
import type { ViewerContextService } from '../viewer/viewer-context.service';

function fixture() {
  const prisma = { message: { findFirst: jest.fn() }, article: { findFirst: jest.fn() }, report: { create: jest.fn(input => input.data) } };
  const channels = { channel: jest.fn() };
  const messages = { listConversationParticipantUserIds: jest.fn() };
  const viewer = { getViewer: jest.fn(), allowedPostVisibilities: jest.fn(() => ['public']) };
  const service = new ReportsService(prisma as unknown as PrismaService, {} as SlackService,
    channels as unknown as ChannelAccessService, messages as unknown as MessagesService,
    viewer as unknown as ViewerContextService, {} as ChannelMediaService);
  return { service, prisma, channels, messages };
}
const input = { reporterUserId: 'member', reason: 'other' as const, details: null };
describe('message and article report access', () => {
  it('rejects a private channel message before storing any evidence when the reporter lacks access', async () => {
    const f = fixture();
    f.prisma.message.findFirst.mockResolvedValue({ id: 'message', body: 'Private', conversationId: 'conversation', conversation: { groupChannel: { id: 'private', groupId: 'group' } } });
    f.channels.channel.mockRejectedValue(new NotFoundException());
    await expect(f.service.create({ ...input, targetType: 'message', subjectMessageId: 'message' })).rejects.toBeInstanceOf(NotFoundException);
    expect(f.prisma.report.create).not.toHaveBeenCalled();
    expect(f.messages.listConversationParticipantUserIds).not.toHaveBeenCalled();
  });
  it('records only the authorized target evidence, without adding private members', async () => {
    const f = fixture();
    f.prisma.message.findFirst.mockResolvedValue({ id: 'message', body: 'Reported evidence', conversation: { groupChannel: { id: 'private', groupId: 'group' } } });
    const report = await f.service.create({ ...input, targetType: 'message', subjectMessageId: 'message' });
    expect(f.channels.channel).toHaveBeenCalledWith('member', 'group', 'private');
    expect(report).toMatchObject({ subjectMessageId: 'message', evidenceText: 'Reported evidence' });
  });
  it('requires legacy Chat access when the message is not in a channel', async () => {
    const f = fixture();
    f.prisma.message.findFirst.mockResolvedValue({ id: 'message', body: 'DM', conversationId: 'dm', conversation: { groupChannel: null } });
    f.messages.listConversationParticipantUserIds.mockRejectedValue(new NotFoundException());
    await expect(f.service.create({ ...input, targetType: 'message', subjectMessageId: 'message' })).rejects.toBeInstanceOf(NotFoundException);
    expect(f.prisma.report.create).not.toHaveBeenCalled();
  });
  it.each([{ isDraft: true, visibility: 'public' }, { isDraft: false, visibility: 'onlyMe' }])('does not expose another author’s inaccessible article (%j)', async flags => {
    const f = fixture();
    f.prisma.article.findFirst.mockResolvedValue({ id: 'article', authorId: 'author', ...flags });
    await expect(f.service.create({ ...input, targetType: 'article', subjectArticleId: 'article' })).rejects.toBeInstanceOf(NotFoundException);
    expect(f.prisma.report.create).not.toHaveBeenCalled();
  });
});
