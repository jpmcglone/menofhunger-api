import type { MessagesMembershipService } from "./messages-membership.service";
import type { MessagesSupportService } from "./messages-support.service";
import type { MessagesQueryService } from "./messages-query.service";
import type { MessagesWriteService } from "./messages-write.service";
import type { MessagesConversationStateService } from "./messages-conversation-state.service";
import type { MessagesReactionsEditsService } from "./messages-reactions-edits.service";
import type { MessagesCallsService } from "./messages-calls.service";
import type { MessagesRealtimeService } from "./messages-realtime.service";
import type { MessagesBotDeliveryService } from "./messages-bot-delivery.service";
export { messageMediaCreateData } from "./messages.models";
/** Test-only composition preserving the existing domain behavior fixtures. */
export function makeMessagesTestApi(
  support: MessagesSupportService,
  query: MessagesQueryService,
  write: MessagesWriteService,
  state: MessagesConversationStateService,
  edits: MessagesReactionsEditsService,
  calls: MessagesCallsService,
  realtime: MessagesRealtimeService,
  bot: MessagesBotDeliveryService,
  membership: MessagesMembershipService,
) {
  return {
    support,
    listConversationParticipantUserIds:
      membership.listConversationParticipantUserIds.bind(membership),
    listConversationMemberUserIds:
      calls.listConversationMemberUserIds.bind(calls),
    getCallConversationContext: calls.getCallConversationContext.bind(calls),
    createCallMessage: calls.createCallMessage.bind(calls),
    rebroadcastMessage: realtime.rebroadcastMessage.bind(realtime),
    updateCallMessage: calls.updateCallMessage.bind(calls),
    listConversations: query.listConversations.bind(query),
    searchConversations: query.searchConversations.bind(query),
    lookupConversation: query.lookupConversation.bind(query),
    getConversation: query.getConversation.bind(query),
    listMessages: query.listMessages.bind(query),
    messagesAround: query.messagesAround.bind(query),
    listMessagesNewer: query.listMessagesNewer.bind(query),
    ensureBotDirectConversation: bot.ensureBotDirectConversation.bind(bot),
    sendBotDirectMessage: bot.sendBotDirectMessage.bind(bot),
    createConversation: write.createConversation.bind(write),
    sendMessage: write.sendMessage.bind(write),
    markRead: state.markRead.bind(state),
    deleteConversation: state.deleteConversation.bind(state),
    acceptConversation: state.acceptConversation.bind(state),
    blockUser: state.blockUser.bind(state),
    getBlockedUserIds: support.getBlockedUserIds.bind(support),
    isBlockedBetween: support.isBlockedBetween.bind(support),
    unblockUser: state.unblockUser.bind(state),
    listBlocks: state.listBlocks.bind(state),
    getUnreadSummary: state.getUnreadSummary.bind(state),
    addReaction: edits.addReaction.bind(edits),
    removeReaction: edits.removeReaction.bind(edits),
    deleteMessageForMe: state.deleteMessageForMe.bind(state),
    restoreMessageForMe: state.restoreMessageForMe.bind(state),
    muteConversation: state.muteConversation.bind(state),
    unmuteConversation: state.unmuteConversation.bind(state),
    attachCallVoicemail: edits.attachCallVoicemail.bind(edits),
    editMessage: edits.editMessage.bind(edits),
    deleteMessageForAll: edits.deleteMessageForAll.bind(edits),
  };
}
