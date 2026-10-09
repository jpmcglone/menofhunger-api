import type { AppConfigService } from '../app/app-config.service';
import type { PresenceRealtimeService } from '../presence/presence-realtime.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SideEffectsService } from '../side-effects/side-effects.service';
import type { ChannelAccessService } from './channel-access.service';
import type { ChannelAttentionService } from './channel-attention.service';
import { ChannelMessageReadService } from './channel-message-read.service';
import type { ChannelMediaService } from './channel-media.service';
import { ChannelMessagesService } from './channel-messages.service';
import type { ChannelsService } from './channels.service';

/** Wires the channel message read and write services by hand for unit tests (the module does this through DI). */
export function makeChannelMessages(deps: {
  prisma: PrismaService;
  access: ChannelAccessService;
  channels: ChannelsService;
  attention: ChannelAttentionService;
  config: AppConfigService;
  realtime: PresenceRealtimeService;
  media: ChannelMediaService;
  effects: SideEffectsService;
}) {
  const reader = new ChannelMessageReadService(deps.prisma, deps.access, deps.channels, deps.config, deps.realtime);
  const writer = new ChannelMessagesService(deps.prisma, deps.access, deps.attention, reader, deps.media, deps.effects);
  return { reader, writer };
}
