import { MessagesReactionsEditsService } from "./messages-reactions-edits.service";
import { MessagesConversationStateService } from "./messages-conversation-state.service";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { CallSessionStoreModule } from "../calls/call-session-store.module";
import { MessagesController } from "./messages.controller";
import { MessagesCallsService } from "./messages-calls.service";
import { MessagesRealtimeService } from "./messages-realtime.service";
import { MessagesMembershipService } from "./messages-membership.service";
import { MessagesBotDeliveryService } from "./messages-bot-delivery.service";
import { MessagesSupportService } from "./messages-support.service";
import { MessagesQueryService } from "./messages-query.service";
import { MessagesBotDmService } from "./messages-bot-dm.service";
import { MessagesWriteService } from "./messages-write.service";
import { UploadGrantsModule } from "../uploads/upload-grants.module";

@Module({
  imports: [
    AuthModule,
    RealtimeModule,
    CallSessionStoreModule,
    UploadGrantsModule,
  ],
  controllers: [MessagesController],
  providers: [
    MessagesBotDmService,
    MessagesReactionsEditsService,
    MessagesConversationStateService,
    MessagesSupportService,
    MessagesQueryService,
    MessagesWriteService,
    MessagesCallsService,
    MessagesRealtimeService,
    MessagesMembershipService,
    MessagesBotDeliveryService,
  ],
  exports: [
    MessagesQueryService,
    MessagesWriteService,
    MessagesConversationStateService,
    MessagesReactionsEditsService,
    MessagesCallsService,
    MessagesRealtimeService,
    MessagesMembershipService,
    MessagesBotDeliveryService,
  ],
})
export class MessagesModule {}
