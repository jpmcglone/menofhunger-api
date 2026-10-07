import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { DomainEventsService } from '../events/domain-events.service';
import { RedisService } from '../redis/redis.service';
import { PosthogService } from '../../common/posthog/posthog.service';
import { JobsService } from '../jobs/jobs.service';
import { MarvinBotIdentityService } from '../marvin/services/marvin-bot-identity.service';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { CallSessionStore } from '../calls/call-session.store';
import { MessagesSupportService } from './messages-support.service';
import { MessagesQueryService } from './messages-query.service';
import { MessagesWriteService } from './messages-write.service';

export type { MessageMediaInput, CallConversationContext } from './messages.models';
export { messageMediaCreateData } from './messages.models';

@Injectable()
export class MessagesService {
  private readonly support: MessagesSupportService;
  readonly query: MessagesQueryService;
  readonly write: MessagesWriteService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly events: DomainEventsService,
    private readonly redis: RedisService,
    private readonly posthog: PosthogService,
    private readonly jobs: JobsService,
    private readonly marvIdentity: MarvinBotIdentityService,
    private readonly sideEffects: SideEffectsService,
    private readonly callSessions: CallSessionStore,
    @Optional() support?: MessagesSupportService,
    @Optional() query?: MessagesQueryService,
    @Optional() write?: MessagesWriteService,
  ) {
    this.support =
      support ??
      new MessagesSupportService(
        prisma, appConfig, presenceRealtime, events, redis, posthog, jobs, marvIdentity, sideEffects, callSessions,
      );
    this.query =
      query ??
      new MessagesQueryService(
        prisma, appConfig, presenceRealtime, events, redis, posthog, jobs, marvIdentity, sideEffects, callSessions, this.support,
      );
    this.write =
      write ??
      new MessagesWriteService(
        prisma, appConfig, presenceRealtime, events, redis, posthog, jobs, marvIdentity, sideEffects, callSessions, this.support,
      );
  }

  listConversationParticipantUserIds(...args: Parameters<MessagesQueryService['listConversationParticipantUserIds']>) {
    return this.query.listConversationParticipantUserIds(...args);
  }
  listConversationMemberUserIds(...args: Parameters<MessagesQueryService['listConversationMemberUserIds']>) {
    return this.query.listConversationMemberUserIds(...args);
  }
  getCallConversationContext(...args: Parameters<MessagesQueryService['getCallConversationContext']>) {
    return this.query.getCallConversationContext(...args);
  }
  createCallMessage(...args: Parameters<MessagesQueryService['createCallMessage']>) {
    return this.query.createCallMessage(...args);
  }
  rebroadcastMessage(...args: Parameters<MessagesQueryService['rebroadcastMessage']>) {
    return this.query.rebroadcastMessage(...args);
  }
  updateCallMessage(...args: Parameters<MessagesQueryService['updateCallMessage']>) {
    return this.query.updateCallMessage(...args);
  }
  listConversations(...args: Parameters<MessagesQueryService['listConversations']>) {
    return this.query.listConversations(...args);
  }
  searchConversations(...args: Parameters<MessagesQueryService['searchConversations']>) {
    return this.query.searchConversations(...args);
  }
  lookupConversation(...args: Parameters<MessagesQueryService['lookupConversation']>) {
    return this.query.lookupConversation(...args);
  }
  getConversation(...args: Parameters<MessagesQueryService['getConversation']>) {
    return this.query.getConversation(...args);
  }
  listMessages(...args: Parameters<MessagesQueryService['listMessages']>) {
    return this.query.listMessages(...args);
  }
  messagesAround(...args: Parameters<MessagesQueryService['messagesAround']>) {
    return this.query.messagesAround(...args);
  }
  listMessagesNewer(...args: Parameters<MessagesQueryService['listMessagesNewer']>) {
    return this.query.listMessagesNewer(...args);
  }
  ensureBotDirectConversation(...args: Parameters<MessagesWriteService['ensureBotDirectConversation']>) {
    return this.write.ensureBotDirectConversation(...args);
  }
  sendBotDirectMessage(...args: Parameters<MessagesWriteService['sendBotDirectMessage']>) {
    return this.write.sendBotDirectMessage(...args);
  }
  createConversation(...args: Parameters<MessagesWriteService['createConversation']>) {
    return this.write.createConversation(...args);
  }
  sendMessage(...args: Parameters<MessagesWriteService['sendMessage']>) {
    return this.write.sendMessage(...args);
  }
  markRead(...args: Parameters<MessagesWriteService['markRead']>) {
    return this.write.markRead(...args);
  }
  deleteConversation(...args: Parameters<MessagesWriteService['deleteConversation']>) {
    return this.write.deleteConversation(...args);
  }
  acceptConversation(...args: Parameters<MessagesWriteService['acceptConversation']>) {
    return this.write.acceptConversation(...args);
  }
  blockUser(...args: Parameters<MessagesWriteService['blockUser']>) {
    return this.write.blockUser(...args);
  }
  getBlockedUserIds(...args: Parameters<MessagesSupportService['getBlockedUserIds']>) {
    return this.support.getBlockedUserIds(...args);
  }
  isBlockedBetween(...args: Parameters<MessagesSupportService['isBlockedBetween']>) {
    return this.support.isBlockedBetween(...args);
  }
  unblockUser(...args: Parameters<MessagesWriteService['unblockUser']>) {
    return this.write.unblockUser(...args);
  }
  listBlocks(...args: Parameters<MessagesWriteService['listBlocks']>) {
    return this.write.listBlocks(...args);
  }
  getUnreadSummary(...args: Parameters<MessagesWriteService['getUnreadSummary']>) {
    return this.write.getUnreadSummary(...args);
  }
  addReaction(...args: Parameters<MessagesWriteService['addReaction']>) {
    return this.write.addReaction(...args);
  }
  removeReaction(...args: Parameters<MessagesWriteService['removeReaction']>) {
    return this.write.removeReaction(...args);
  }
  deleteMessageForMe(...args: Parameters<MessagesWriteService['deleteMessageForMe']>) {
    return this.write.deleteMessageForMe(...args);
  }
  restoreMessageForMe(...args: Parameters<MessagesWriteService['restoreMessageForMe']>) {
    return this.write.restoreMessageForMe(...args);
  }
  muteConversation(...args: Parameters<MessagesWriteService['muteConversation']>) {
    return this.write.muteConversation(...args);
  }
  unmuteConversation(...args: Parameters<MessagesWriteService['unmuteConversation']>) {
    return this.write.unmuteConversation(...args);
  }
  attachCallVoicemail(...args: Parameters<MessagesWriteService['attachCallVoicemail']>) {
    return this.write.attachCallVoicemail(...args);
  }
  editMessage(...args: Parameters<MessagesWriteService['editMessage']>) {
    return this.write.editMessage(...args);
  }
  deleteMessageForAll(...args: Parameters<MessagesWriteService['deleteMessageForAll']>) {
    return this.write.deleteMessageForAll(...args);
  }
}
