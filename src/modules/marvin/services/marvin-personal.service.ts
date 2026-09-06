import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { MarvinPersonalAction, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { BookmarksService } from '../../bookmarks/bookmarks.service';
import { NotificationPreferencesService } from '../../notifications/notification-preferences.service';
import { PresenceRealtimeService } from '../../presence/presence-realtime.service';
import { personalActionSchema } from './marvin-personal-tools';
import type { MarvAIToolCallContext } from './marvin-ai.service';
import type { MarvinPersonalActionDto } from '../../../common/dto/marvin/marvin-personal.dto';

@Injectable()
export class MarvinPersonalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookmarks: BookmarksService,
    private readonly preferences: NotificationPreferencesService,
    private readonly realtime: PresenceRealtimeService,
  ) {}

  async assertPrivate(ctx: MarvAIToolCallContext) {
    if (!ctx.conversationId) throw new ForbiddenException('Use your private chat with MARV.');
    const conversation = await this.prisma.messageConversation.findFirst({ where: {
      id: ctx.conversationId, type: 'direct',
      participants: { some: { userId: ctx.requesterUserId, status: 'accepted' } },
    }, select: { participants: { select: { userId: true, user: { select: { botType: true } } } } } });
    if (!conversation || conversation.participants.length !== 2 || !conversation.participants.some(p => p.user.botType === 'marvin')) {
      throw new ForbiddenException('Use your private chat with MARV.');
    }
  }

  async readPreferences(ctx: MarvAIToolCallContext) {
    await this.assertPrivate(ctx);
    return this.preferences.getPreferences(ctx.requesterUserId);
  }

  async prepare(args: unknown, ctx: MarvAIToolCallContext) {
    await this.assertPrivate(ctx);
    const { action } = z.object({ action: personalActionSchema }).strict().parse(args);
    const userId = ctx.requesterUserId;
    const message = ctx.requesterMessageId && await this.prisma.message.findFirst({ where: {
      id: ctx.requesterMessageId, senderId: userId, conversationId: ctx.conversationId, deletedForAll: false,
    }, select: { id: true } });
    if (!message) throw new ForbiddenException('This action needs a current message from you.');
    const requestKey = createHash('sha256').update(JSON.stringify([userId, message.id, action])).digest('hex');
    const existing = await this.prisma.marvinPersonalAction.findUnique({ where: { requestKey } });
    if (existing) return this.preparedResult(existing);
    if (await this.prisma.marvinPersonalAction.count({ where: { userId, messageId: message.id } }) >= 4) {
      throw new BadRequestException('Review these actions before requesting more.');
    }
    let title: string;
    let preview: string;
    let before: Record<string, unknown> = {};
    if (action.kind === 'bookmark') {
      const post = await this.prisma.post.findFirst({ where: {
        id: action.postId, visibility: 'public', communityGroupId: null, deletedAt: null, isDraft: false,
        user: { bannedAt: null, blocksInitiated: { none: { blockedId: userId } }, blocksReceived: { none: { blockerId: userId } } },
      }, select: { body: true, user: { select: { username: true } } } });
      if (!post) throw new NotFoundException('Choose an available public post.');
      title = 'Save bookmark';
      preview = `@${post.user.username ?? 'member'}\n${post.body.slice(0, 500)}`;
    } else if (action.kind === 'preferences') {
      const current = await this.preferences.getPreferences(userId);
      const entries = Object.entries(action.changes);
      before = Object.fromEntries(entries.map(([key]) => [key, current[key as keyof typeof current]]));
      title = 'Update notifications';
      preview = entries.map(([key, value]) => `${key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())}: ${before[key] ? 'On' : 'Off'} → ${value ? 'On' : 'Off'}`).join('\n');
    } else {
      title = action.title;
      preview = action.body;
    }
    const row = await this.prisma.marvinPersonalAction.create({ data: {
      userId, requestKey, messageId: message.id, kind: action.kind, title, preview,
      input: action as Prisma.InputJsonValue, before: before as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + 24 * 60 * 60000),
    } });
    this.realtime.emitMarvActionsUpdated(userId);
    return this.preparedResult(row);
  }

  async list(userId: string): Promise<MarvinPersonalActionDto[]> {
    const rows = await this.prisma.marvinPersonalAction.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 30 });
    return rows.map(row => this.dto(row));
  }

  async decide(userId: string, id: string, decision: 'confirm' | 'cancel'): Promise<MarvinPersonalActionDto> {
    const row = await this.prisma.marvinPersonalAction.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('Action not found.');
    if (row.status !== 'pending') return this.dto(row);
    const expired = row.expiresAt.getTime() <= Date.now();
    const status = expired ? 'expired' : decision === 'cancel' ? 'cancelled' : 'executing';
    const claimed = await this.prisma.marvinPersonalAction.updateMany({ where: { id, userId, status: 'pending' }, data: { status } });
    if (!claimed.count) return this.dto((await this.prisma.marvinPersonalAction.findFirstOrThrow({ where: { id, userId } })));
    if (status !== 'executing') {
      this.realtime.emitMarvActionsUpdated(userId);
      return this.dto({ ...row, status });
    }
    let receipt: string;
    let finalStatus = 'applied';
    try {
      const action = personalActionSchema.parse(row.input);
      if (action.kind === 'bookmark') {
        await this.bookmarks.setBookmark({ userId, postId: action.postId, collectionIds: null });
        receipt = 'Bookmark saved.';
      } else if (action.kind === 'preferences') {
        const current = await this.preferences.getPreferences(userId);
        const before = row.before as Record<string, boolean>;
        if (Object.keys(action.changes).some(k => current[k as keyof typeof current] !== before[k])) {
          throw new BadRequestException('Your preferences changed. Ask MARV to prepare a fresh review.');
        }
        const updated = await this.preferences.updatePreferences(userId, action.changes);
        const complete = Object.entries(action.changes).every(([k, v]) => updated[k as keyof typeof updated] === v);
        receipt = complete ? 'Notification preferences updated.' : 'Some email settings could not change. Verify your email in Settings, then review your notification preferences.';
      } else {
        receipt = 'Draft kept here. Copy it into the composer when you are ready; it has not been published or recorded as a check-in.';
      }
    } catch (error) {
      finalStatus = 'failed';
      receipt = error instanceof BadRequestException || error instanceof NotFoundException || error instanceof ForbiddenException
        ? error.message : 'Could not confirm completion. Check Bookmarks or Settings before trying again.';
    }
    const updated = await this.prisma.marvinPersonalAction.update({ where: { id }, data: { status: finalStatus, receipt } });
    this.realtime.emitMarvActionsUpdated(userId);
    return this.dto(updated);
  }

  private preparedResult(row: MarvinPersonalAction) {
    return { id: row.id, title: row.title, status: row.status, preview: row.preview.slice(0, 800),
      instruction: 'Prepared only. Open Actions in this private chat to review. No post, message, or check-in has been published.' };
  }

  private dto(row: MarvinPersonalAction): MarvinPersonalActionDto {
    const action = personalActionSchema.parse(row.input);
    return { id: row.id, kind: action.kind, title: row.title, preview: row.preview,
      draft: action.kind === 'draft' ? action.body : null, status: row.status === 'pending' && row.expiresAt.getTime() <= Date.now() ? 'expired' : row.status,
      createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), receipt: row.receipt };
  }
}
