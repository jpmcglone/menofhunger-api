import type { GroupChannelMarvStatusDto } from '../../common/dto/group-channel.dto';
import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { parseMentionsFromBody } from '../../common/mentions/mention-regex';
import { AppConfigService } from '../app/app-config.service';
import { AI_CONSENT_VERSION, requireAiConsent } from '../marvin/services/ai-consent';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { ChannelAccessService } from './channel-access.service';
import { isChannelLeader } from './channel-policy';

export type ChannelMarvRequest = { groupId: string; channelId: string; messageId: string; requesterId: string };
export type ChannelMarvEvidence = { id: string; channelId: string; digest: string };
export type ChannelMarvGrant = { botId: string; invitation: string; membership: string; triggerDigest: string };
/** The destination is server-owned. A model can supply a query, never an audience or channel ID. */
export function marvChannelSourceWhere(groupId: string, channelId: string, privateDestination: boolean): Prisma.GroupChannelWhereInput {
  return { groupId, group: { deletedAt: null }, OR: [{ privacy: 'normal' }, ...(privateDestination ? [{ id: channelId, privacy: 'private' as const }] : [])] };
}

@Injectable()
export class ChannelMarvScopeService {
  constructor(private readonly prisma: PrismaService, private readonly config: AppConfigService,
    private readonly access: ChannelAccessService, private readonly realtime: PresenceRealtimeService) {}

  private enabled(groupId: string) { return this.access.enabled(groupId) && this.config.groupChannels().marvEnabled && this.config.marvBot().enabled; }
  private bot(db: Prisma.TransactionClient = this.prisma) {
    const configured = this.config.marvBot();
    return db.user.findFirst({ where: { ...(configured.userId ? { id: configured.userId } : { username: { equals: configured.username, mode: 'insensitive' as const } }), isBot: true, botType: 'marvin', bannedAt: null }, select: { id: true, username: true } });
  }
  mentions(body: string) { return parseMentionsFromBody(body).some(name => name.toLowerCase() === this.config.marvBot().username.toLowerCase()); }

  async status(userId: string, groupId: string, channelId: string): Promise<GroupChannelMarvStatusDto> {
    const { channel, member } = await this.access.channel(userId, groupId, channelId);
    const bot = await this.bot();
    const membership = bot ? await this.prisma.communityGroupMember.findUnique({ where: { groupId_userId: { groupId, userId: bot.id } } }) : null;
    const grant = bot ? await this.prisma.groupChannelAccess.findUnique({ where: { channelId_userId: { channelId, userId: bot.id } } }) : null;
    return { enabled: this.enabled(groupId), inGroup: membership?.status === 'active', participating: membership?.status === 'active' && !!grant,
      canManage: isChannelLeader(member.role) && !channel.archivedAt, userId: bot?.id ?? null };
  }

  async mentionMember(userId: string, groupId: string, channelId: string, query = '') {
    if (!this.enabled(groupId)) return [];
    const status = await this.status(userId, groupId, channelId);
    if (!status.participating || !status.userId) return [];
    const user = await this.prisma.user.findUnique({ where: { id: status.userId }, select: { id: true, username: true, name: true, isBot: true } });
    if (!user || (query && !`${user.username} ${user.name}`.toLowerCase().includes(query.toLowerCase()))) return [];
    return [{ role: 'member', user }];
  }

  async participation(userId: string, groupId: string, channelId: string, invited: boolean, historyAcknowledged: boolean) {
    if (!this.enabled(groupId)) throw new NotFoundException('MARV channel replies are not available.');
    if (invited && !historyAcknowledged) throw new BadRequestException('Confirm MARV can use the retained channel history.');
    await this.prisma.$transaction(async tx => {
      await this.access.lockGroup(tx, groupId);
      const { channel, member } = await this.access.channel(userId, groupId, channelId, tx);
      if (!isChannelLeader(member.role) || channel.archivedAt) throw new ForbiddenException('Only a leader in this channel can manage MARV.');
      const bot = await this.bot(tx);
      const membership = bot ? await tx.communityGroupMember.findUnique({ where: { groupId_userId: { groupId, userId: bot.id } } }) : null;
      if (!bot || membership?.status !== 'active') throw new BadRequestException('Add MARV to the group first.');
      if (invited) await tx.groupChannelAccess.upsert({ where: { channelId_userId: { channelId, userId: bot.id } }, create: { channelId, userId: bot.id }, update: {} });
      else await tx.groupChannelAccess.deleteMany({ where: { channelId, userId: bot.id } });
    });
    for (const recipient of await this.access.recipients(groupId, channelId)) this.realtime.emitGroupChannelChanged(recipient.userId, { groupId, channelId, reason: 'access' });
  }

  async preflight(userId: string, groupId: string, channelId: string, body: string) {
    if (!this.enabled(groupId) || !this.mentions(body)) return;
    const status = await this.status(userId, groupId, channelId);
    if (status.participating) await requireAiConsent(this.prisma, userId);
  }

  async authorize(input: ChannelMarvRequest, expected?: ChannelMarvGrant, db: Prisma.TransactionClient = this.prisma) {
    if (!this.enabled(input.groupId)) throw new NotFoundException('MARV channel replies unavailable.');
    const { channel } = await this.access.channel(input.requesterId, input.groupId, input.channelId, db);
    const [requester, settings] = await Promise.all([
      db.user.findUnique({ where: { id: input.requesterId }, select: { premium: true, premiumPlus: true } }),
      db.marvinUserSettings.findUnique({ where: { userId: input.requesterId }, select: { aiConsentAt: true, aiConsentVersion: true, disabledByAdmin: true } }),
    ]);
    if (!requester || (!requester.premium && !requester.premiumPlus) || settings?.disabledByAdmin || !settings?.aiConsentAt || settings.aiConsentVersion !== AI_CONSENT_VERSION) throw new NotFoundException('MARV permission changed.');
    if (channel.archivedAt) throw new NotFoundException();
    const bot = await this.bot(db);
    const membership = bot ? await db.communityGroupMember.findUnique({ where: { groupId_userId: { groupId: input.groupId, userId: bot.id } } }) : null;
    const invitation = bot ? await db.groupChannelAccess.findUnique({ where: { channelId_userId: { channelId: input.channelId, userId: bot.id } } }) : null;
    const trigger = await db.message.findFirst({ where: { id: input.messageId, conversationId: channel.conversationId, senderId: input.requesterId, deletedForAll: false } });
    if (!bot || membership?.status !== 'active' || !invitation || !trigger || !this.mentions(trigger.body)) throw new NotFoundException('MARV participation changed.');
    if (channel.defaultPurpose === 'announcements' && !isChannelLeader(membership.role)) throw new NotFoundException('Only leaders can post announcements.');
    const grant = { botId: bot.id, invitation: invitation.createdAt.toISOString(), membership: membership.createdAt.toISOString(), triggerDigest: createHash('sha256').update(trigger.body).digest('hex') };
    if (expected && Object.keys(grant).some(key => grant[key as keyof typeof grant] !== expected[key as keyof ChannelMarvGrant])) throw new NotFoundException('MARV participation changed.');
    return { channel, trigger, grant };
  }

  async retrieve(input: ChannelMarvRequest, grant: ChannelMarvGrant, query = '') {
    const { channel } = await this.authorize(input, grant);
    const rows = await this.prisma.message.findMany({ where: {
      deletedForAll: false, conversation: { groupChannel: { ...marvChannelSourceWhere(input.groupId, input.channelId, channel.privacy === 'private'), ...(!query ? { id: input.channelId } : {}) } },
      ...(query ? { body: { contains: query.slice(0, 200), mode: 'insensitive' as const } } : {}),
    }, select: { id: true, body: true, createdAt: true, channelRevision: true, sender: { select: { username: true } }, conversation: { select: { groupChannel: { select: { id: true, name: true } } } } }, orderBy: { createdAt: 'desc' }, take: 30 });
    await this.authorize(input, grant);
    return rows.reverse().map(row => ({ id: row.id, channelId: row.conversation.groupChannel!.id, channel: row.conversation.groupChannel!.name,
      digest: createHash('sha256').update(row.body).digest('hex'), author: row.sender.username, body: row.body, createdAt: row.createdAt.toISOString() }));
  }

  async validateEvidence(input: ChannelMarvRequest, grant: ChannelMarvGrant, evidence: ChannelMarvEvidence[], db: Prisma.TransactionClient = this.prisma) {
    const authorized = await this.authorize(input, grant, db);
    const sources = await db.message.findMany({ where: { id: { in: evidence.map(source => source.id) }, deletedForAll: false,
      conversation: { groupChannel: marvChannelSourceWhere(input.groupId, input.channelId, authorized.channel.privacy === 'private') } }, select: { id: true, body: true } });
    if (evidence.some(source => !sources.some(current => current.id === source.id && createHash('sha256').update(current.body).digest('hex') === source.digest))) throw new NotFoundException('Source content changed.');
    return authorized;
  }
}
