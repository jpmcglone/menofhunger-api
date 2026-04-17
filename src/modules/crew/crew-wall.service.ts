import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MessagesService, type MessageMediaInput } from '../messages/messages.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { CrewService } from './crew.service';

/**
 * Thin wall layer. The wall conversation is a plain `MessageConversation` with type
 * `crew_wall`; all heavy lifting (send, list, edit, react, delete) is handled by
 * {@link MessagesService}. This service just exposes crew-centric entry points:
 *  - resolves "my wall" without requiring the client to know the conversation id
 *  - adds crew-specific realtime mirrors (`crew:wall:*`)
 *  - fans out `crew_wall_mention` notifications for @username mentions
 */
@Injectable()
export class CrewWallService {
  private readonly logger = new Logger(CrewWallService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: MessagesService,
    private readonly notifications: NotificationsService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly crew: CrewService,
  ) {}

  private async requireMyCrew(viewerUserId: string): Promise<{
    crewId: string;
    conversationId: string;
    memberIds: string[];
  }> {
    const mem = await this.prisma.crewMember.findUnique({
      where: { userId: viewerUserId },
      select: { crewId: true },
    });
    if (!mem) throw new NotFoundException('You are not in a crew.');
    const crew = await this.prisma.crew.findUnique({
      where: { id: mem.crewId },
      select: {
        id: true,
        deletedAt: true,
        wallConversationId: true,
        members: { select: { userId: true } },
      },
    });
    if (!crew || crew.deletedAt) throw new NotFoundException('Crew not found.');
    return {
      crewId: crew.id,
      conversationId: crew.wallConversationId,
      memberIds: crew.members.map((m) => m.userId),
    };
  }

  async getMyWall(params: { viewerUserId: string; limit?: number; cursor?: string | null }) {
    const ctx = await this.requireMyCrew(params.viewerUserId);
    const result = await this.messages.listMessages({
      userId: params.viewerUserId,
      conversationId: ctx.conversationId,
      limit: params.limit,
      cursor: params.cursor ?? null,
    });
    return {
      crewId: ctx.crewId,
      conversationId: ctx.conversationId,
      messages: result.messages,
      nextCursor: result.nextCursor,
    };
  }

  async sendWallMessage(params: {
    viewerUserId: string;
    body: string;
    replyToId?: string | null;
    media?: MessageMediaInput[];
  }) {
    await this.crew.assertVerified(params.viewerUserId);
    const ctx = await this.requireMyCrew(params.viewerUserId);

    // Wall does not support threaded replies per product spec.
    if (params.replyToId) {
      throw new BadRequestException('Wall messages do not support threaded replies.');
    }

    const result = await this.messages.sendMessage({
      userId: params.viewerUserId,
      conversationId: ctx.conversationId,
      body: params.body,
      replyToId: null,
      media: params.media ?? [],
    });

    // Mirror as a crew-shaped realtime event so clients that only subscribe to
    // `crew:wall:*` still see the message without duplicating message plumbing.
    this.presenceRealtime.emitCrewWallMessage(ctx.memberIds, {
      crewId: ctx.crewId,
      conversationId: ctx.conversationId,
      message: result.message,
    });

    // @mention fan-out to crew members only (we never leak mentions to non-members).
    const mentionedUsernames = extractMentions(params.body ?? '');
    if (mentionedUsernames.length > 0) {
      const mentioned = await this.prisma.user.findMany({
        where: {
          username: { in: mentionedUsernames, mode: 'insensitive' },
          id: { in: ctx.memberIds },
        },
        select: { id: true },
      });
      for (const u of mentioned) {
        if (u.id === params.viewerUserId) continue;
        await this.notifications.create({
          recipientUserId: u.id,
          kind: 'crew_wall_mention',
          actorUserId: params.viewerUserId,
          subjectCrewId: ctx.crewId,
          body: (params.body ?? '').trim().slice(0, 200) || null,
        });
      }
    }

    return result;
  }

  /**
   * Ensure wall participants reflect current crew members. Called defensively from
   * admin tools and ownership transfers; creation/join/leave flows keep participants
   * in sync inline for immediacy.
   */
  async reconcileParticipants(crewId: string): Promise<void> {
    const crew = await this.prisma.crew.findUnique({
      where: { id: crewId },
      select: {
        wallConversationId: true,
        members: { select: { userId: true } },
      },
    });
    if (!crew) return;
    const memberIds = new Set(crew.members.map((m) => m.userId));
    const existing = await this.prisma.messageParticipant.findMany({
      where: { conversationId: crew.wallConversationId },
      select: { userId: true },
    });
    const have = new Set(existing.map((p) => p.userId));
    const toAdd = [...memberIds].filter((id) => !have.has(id));
    const toRemove = [...have].filter((id) => !memberIds.has(id));
    const now = new Date();
    if (toAdd.length > 0) {
      await this.prisma.messageParticipant.createMany({
        data: toAdd.map((userId) => ({
          conversationId: crew.wallConversationId,
          userId,
          role: 'member' as const,
          status: 'accepted' as const,
          acceptedAt: now,
        })),
        skipDuplicates: true,
      });
    }
    if (toRemove.length > 0) {
      await this.prisma.messageParticipant.deleteMany({
        where: { conversationId: crew.wallConversationId, userId: { in: toRemove } },
      });
    }
  }
}

/** Case-insensitive @username mention extractor. Filters usernames to <= 32 chars. */
function extractMentions(body: string): string[] {
  if (!body) return [];
  const re = /(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{2,32})/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.add(m[2].toLowerCase());
  }
  return [...out];
}
