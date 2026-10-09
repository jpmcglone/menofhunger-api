import { ChannelAnalyticsService } from './channel-analytics.service';
import { ChannelMarvScopeService } from './channel-marv-scope.service';
import { BadRequestException, Body, Controller, Headers, Res, StreamableFile, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { Readable } from 'node:stream';
import { ChannelViewingService } from './channel-viewing.service';
import { ChannelMediaService } from './channel-media.service';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth-public-api';
import { CurrentUserId, IsImpersonating } from '../users/users.decorator';
import { ChannelsService } from './channels.service';
import { ChannelMessageReadService } from './channel-message-read.service';
import { ChannelMessagesService } from './channel-messages.service';
import { ChannelAttentionService } from './channel-attention.service';
import { id, sequence, create, update } from './group-channels.schemas';

@ApiTags('Group channels')
@Controller('groups/:groupId/channels')
@UseGuards(AuthGuard)
export class GroupChannelsController {
  constructor(
    private readonly analytics: ChannelAnalyticsService,
    private readonly marv: ChannelMarvScopeService,
    private readonly channels: ChannelsService,
    private readonly messages: ChannelMessagesService,
    private readonly reads: ChannelMessageReadService,
    private readonly attention: ChannelAttentionService,
    private readonly media: ChannelMediaService,
    private readonly panes: ChannelViewingService,
  ) {}

  @Get()
  async list(@CurrentUserId() user: string, @Param('groupId') group: string) {
    return { data: await this.channels.list(user, group) };
  }

  @Post()
  async create(@CurrentUserId() user: string, @Param('groupId') group: string, @Body() body: unknown) {
    return { data: await this.channels.create(user, group, create.parse(body)) };
  }

  @Get('for-you')
  async personal(@CurrentUserId() user: string, @Param('groupId') group: string) {
    return { data: await this.reads.personal(user, group) };
  }

  /** Group-wide when `channelId` is omitted; results only include channels the viewer can read. */
  @Get('search')
  async search(@CurrentUserId() user: string, @Param('groupId') group: string, @Query() query: unknown) {
    const input = z.object({ q: z.string().trim().min(1).max(200), channelId: id.optional(), before: id.optional() }).parse(query);
    const result = await this.reads.search(user, group, input);
    return { data: result.messages, pagination: { nextCursor: result.nextCursor } };
  }

  @Get(':channelId')
  async details(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string) {
    return { data: await this.channels.details(user, group, channel) };
  }

  @Patch(':channelId')
  async update(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Body() body: unknown) {
    return { data: await this.channels.update(user, group, channel, update.parse(body)) };
  }

  @Get(':channelId/marv')
  async marvStatus(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string) {
    return { data: await this.marv.status(user, group, channel) };
  }

  @Put(':channelId/marv')
  async marvParticipation(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Body() body: unknown) {
    const input = z
      .object({ invited: z.boolean(), historyAcknowledged: z.boolean().default(false) })
      .strict()
      .parse(body);
    await this.marv.participation(user, group, channel, input.invited, input.historyAcknowledged);
    return { data: {} };
  }

  @Get(':channelId/members')
  async members(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Query() query: unknown) {
    const { q } = z.object({ q: z.string().trim().max(100).optional() }).parse(query);
    const members = await this.channels.members(user, group, channel, q);
    return { data: [...members, ...(await this.marv.mentionMember(user, group, channel, q))] };
  }

  @Post(':channelId/members')
  async addMember(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Body() body: unknown) {
    const input = z
      .object({ userId: id, historyAcknowledged: z.literal(true) })
      .strict()
      .parse(body);
    await this.channels.addMember(user, group, channel, input.userId, input.historyAcknowledged);
    return { data: {} };
  }

  @Delete(':channelId/members/:userId')
  async removeMember(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Param('userId') target: string) {
    await this.channels.removeMember(user, group, channel, target);
    if (user === target) this.analytics.capture(user, 'channel_left');
    return { data: {} };
  }

  @Get(':channelId/messages')
  async history(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Query() query: unknown) {
    const input = z
      .object({
        before: sequence.optional(),
        changedSince: z.coerce.number().int().min(0).optional(),
        root: id.optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .refine((v) => !(v.before && v.changedSince !== undefined), 'Choose one pagination direction.')
      .parse(query);
    const result = await this.reads.list(user, group, channel, input);
    return {
      data: result.messages,
      pagination: { nextCursor: result.nextCursor, latestSequence: result.latestSequence },
    };
  }

  @Get(':channelId/messages/:messageId/context')
  async context(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Param('messageId') message: string) {
    return { data: await this.reads.context(user, group, channel, message) };
  }

  @Post(':channelId/messages')
  async send(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Body() body: unknown) {
    const giphyUrl = z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === 'https:' && (url.hostname === 'giphy.com' || url.hostname.endsWith('.giphy.com'));
      }, 'Choose a GIF from Giphy.');
    const input = z
      .object({
        body: z.string().trim().max(2000).default(''),
        clientRequestId: z.string().uuid(),
        threadRootId: id.optional(),
        replyToId: id.optional(),
        uploadId: z.string().uuid().optional(),
        thumbnailUploadId: z.string().uuid().optional(),
        alt: z.string().max(500).optional(),
        attachments: z
          .array(
            z
              .object({
                uploadId: z.string().uuid(),
                thumbnailUploadId: z.string().uuid().optional(),
                alt: z.string().max(500).optional(),
              })
              .strict(),
          )
          .max(4)
          .optional(),
        giphy: z
          .object({
            url: giphyUrl,
            mp4Url: giphyUrl.optional(),
            width: z.number().int().positive().optional(),
            height: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine((value) => !((value.uploadId || value.attachments?.length) && value.giphy), 'Attach uploads or a GIF, not both.')
      .refine((value) => !(value.uploadId && value.attachments), 'Use attachments or uploadId, not both.')
      .refine((value) => !value.thumbnailUploadId || value.uploadId, 'Thumbnail requires a video.')
      .parse(body);
    await this.marv.preflight(user, group, channel, input.body);
    const message = await this.messages.send(user, group, channel, input);
    await this.analytics.sent(user, message.id);
    return { data: message };
  }

  @Patch(':channelId/messages/:messageId')
  async edit(
    @CurrentUserId() user: string,
    @Param('groupId') group: string,
    @Param('channelId') channel: string,
    @Param('messageId') message: string,
    @Body() body: unknown,
  ) {
    await this.messages.edit(
      user,
      group,
      channel,
      message,
      z
        .object({ body: z.string().trim().min(1).max(2000) })
        .strict()
        .parse(body).body,
    );
    return { data: {} };
  }

  @Put(':channelId/messages/:messageId/previews')
  async hidePreview(
    @CurrentUserId() user: string,
    @Param('groupId') group: string,
    @Param('channelId') channel: string,
    @Param('messageId') message: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({ url: z.string().trim().min(1).max(2000), hidden: z.boolean() })
      .strict()
      .parse(body);
    await this.messages.hidePreview(user, group, channel, message, input.url, input.hidden);
    return { data: {} };
  }

  @Delete(':channelId/messages/:messageId')
  async delete(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Param('messageId') message: string) {
    await this.messages.delete(user, group, channel, message);
    return { data: {} };
  }

  /** Welcome button on a "joined the group" row: posts the viewer's welcome message (idempotent). */
  @Post(':channelId/messages/:messageId/welcome')
  async welcome(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Param('messageId') message: string) {
    return { data: await this.messages.welcome(user, group, channel, message) };
  }

  @Put(':channelId/messages/:messageId/reactions/:reactionId')
  async addReaction(
    @CurrentUserId() user: string,
    @Param('groupId') group: string,
    @Param('channelId') channel: string,
    @Param('messageId') message: string,
    @Param('reactionId') reaction: string,
  ) {
    await this.messages.reaction(user, group, channel, message, reaction, true);
    return { data: {} };
  }

  @Delete(':channelId/messages/:messageId/reactions/:reactionId')
  async removeReaction(
    @CurrentUserId() user: string,
    @Param('groupId') group: string,
    @Param('channelId') channel: string,
    @Param('messageId') message: string,
    @Param('reactionId') reaction: string,
  ) {
    await this.messages.reaction(user, group, channel, message, reaction, false);
    return { data: {} };
  }

  @Put(':channelId/messages/:messageId/pin')
  async pin(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Param('messageId') message: string) {
    await this.messages.pin(user, group, channel, message, true);
    return { data: {} };
  }

  @Delete(':channelId/messages/:messageId/pin')
  async unpin(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Param('messageId') message: string) {
    await this.messages.pin(user, group, channel, message, false);
    return { data: {} };
  }

  @Get(':channelId/pins')
  async pins(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string) {
    return { data: await this.reads.pins(user, group, channel) };
  }

  @Put(':channelId/viewing')
  async viewing(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Body() body: unknown) {
    const input = z.object({ active: z.boolean(), clientId: z.string().uuid().optional() }).strict().parse(body);
    await this.panes.viewing(user, group, channel, input.active, input.clientId);
    return { data: {} };
  }

  @Post(':channelId/read')
  async read(
    @CurrentUserId() user: string,
    @IsImpersonating() impersonating: boolean,
    @Param('groupId') group: string,
    @Param('channelId') channel: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        messageIds: z.array(id).max(100),
        through: z.number().int().min(0).optional(),
        threadRootId: id.optional(),
      })
      .strict()
      .parse(body);
    if (!impersonating) {
      const advanced = await this.attention.acknowledge(user, group, channel, input);
      // Senders learn their messages were read; a failure here must not fail the reader's acknowledgement.
      if (advanced) await this.reads.broadcastReceipts(group, channel, user, advanced).catch(() => undefined);
    }
    return { data: {} };
  }

  @Post(':channelId/unread')
  async unread(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Body() body: unknown) {
    await this.attention.markUnread(user, group, channel, z.object({ messageId: id }).strict().parse(body).messageId);
    return { data: {} };
  }

  @Post(':channelId/read-all')
  async readAll(
    @CurrentUserId() user: string,
    @IsImpersonating() impersonating: boolean,
    @Param('groupId') group: string,
    @Param('channelId') channel: string,
  ) {
    if (!impersonating) {
      const advanced = await this.attention.markAllRead(user, group, channel);
      if (advanced) await this.reads.broadcastReceipts(group, channel, user, advanced).catch(() => undefined);
    }
    return { data: {} };
  }

  /** `until` is an ISO time, `forever`, or null to unmute. */
  @Put(':channelId/mute')
  async mute(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Body() body: unknown) {
    const { until } = z
      .object({ until: z.union([z.literal('forever'), z.string().datetime(), z.null()]) })
      .strict()
      .parse(body);
    const at = until === 'forever' ? new Date('9999-12-31T00:00:00Z') : until ? new Date(until) : null;
    if (at && at.getTime() <= Date.now()) throw new BadRequestException('Choose a time in the future.');
    await this.attention.mute(user, group, channel, at);
    this.analytics.capture(user, 'channel_preference_changed', at ? 'muted' : 'unmuted');
    return { data: {} };
  }

  @Put(':channelId/hidden')
  async hidden(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Body() body: unknown) {
    const { hidden } = z.object({ hidden: z.boolean() }).strict().parse(body);
    await this.attention.hide(user, group, channel, hidden);
    return { data: {} };
  }

  @Put(':channelId/preference')
  async preference(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Body() body: unknown) {
    const { preference } = z
      .object({ preference: z.enum(['all', 'mentions', 'off']) })
      .strict()
      .parse(body);
    await this.attention.preference(user, group, channel, preference);
    this.analytics.capture(user, 'channel_preference_changed', preference);
    return { data: {} };
  }

  @Put(':channelId/threads/:rootId/follow')
  async follow(
    @CurrentUserId() user: string,
    @Param('groupId') group: string,
    @Param('channelId') channel: string,
    @Param('rootId') root: string,
    @Body() body: unknown,
  ) {
    await this.attention.follow(user, group, channel, root, z.object({ following: z.boolean() }).strict().parse(body).following);
    return { data: {} };
  }
  @Post(':channelId/uploads')
  async initializeUpload(@CurrentUserId() user: string, @Param('groupId') group: string, @Param('channelId') channel: string, @Body() body: unknown) {
    return {
      data: await this.media.initialize(
        user,
        group,
        channel,
        z
          .object({ contentType: z.string().max(100), bytes: z.number().int().positive() })
          .strict()
          .parse(body),
      ),
    };
  }

  @Post(':channelId/uploads/:uploadId/commit')
  async commitUpload(
    @CurrentUserId() user: string,
    @Param('groupId') group: string,
    @Param('channelId') channel: string,
    @Param('uploadId') upload: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        durationSeconds: z.number().nonnegative().optional(),
      })
      .strict()
      .parse(body);
    return { data: await this.media.commit(user, group, channel, upload, input) };
  }

  @Get(':channelId/media/:mediaId')
  async readMedia(
    @CurrentUserId() user: string,
    @Param('groupId') group: string,
    @Param('channelId') channel: string,
    @Param('mediaId') media: string,
    @Query() query: unknown,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const thumbnail = z.object({ thumbnail: z.enum(['true', 'false']).optional() }).parse(query).thumbnail === 'true';
    const object = await this.media.read(user, group, channel, media, thumbnail, range);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Vary', 'Authorization, Cookie');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Accept-Ranges', 'bytes');
    if (object.ContentRange) {
      response.status(206);
      response.setHeader('Content-Range', object.ContentRange);
    }
    return new StreamableFile(object.Body as Readable, {
      type: object.ContentType ?? 'application/octet-stream',
      length: object.ContentLength,
    });
  }
}
